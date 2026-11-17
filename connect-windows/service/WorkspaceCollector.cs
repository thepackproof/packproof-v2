using System.Collections.Concurrent;
using System.Text.Json;

namespace PackProof.Connect;

public sealed partial class AgentRuntime
{
    // Callbacks only mark a folder dirty. Reconciliation and immutable admission run
    // on the serialized service lane. A wakeup can be lost without losing the cursor.
    private readonly Dictionary<string,FileSystemWatcher> workspaceWatchers = [];
    private readonly ConcurrentDictionary<string,string> workspaceChanges = new();
    private const int SourceDirectoryLimit = 10000;
    private static string[] WorkspaceFiles(string folder)
    {
        var names = new List<string>();
        foreach (var info in new DirectoryInfo(folder).EnumerateFileSystemInfos("*", SearchOption.TopDirectoryOnly).Take(SourceDirectoryLimit + 1))
        {
            names.Add((info.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint | FileAttributes.Offline)) != 0
                || info.Name.StartsWith('~') || info.Extension.ToLowerInvariant() is ".tmp" or ".part" or ".partial" ? "" : info.Name);
        }
        if (names.Count > SourceDirectoryLimit) throw new ConnectException("SOURCE_CAPACITY_REACHED", "Choose a folder with 10,000 or fewer entries.");
        return names.Where(n => n.Length > 0).Order(StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private void MonitorWorkspaceSource(WorkspaceSource source)
    {
        if (workspaceWatchers.ContainsKey(source.Id)) return;
        var watcher = new FileSystemWatcher(source.Folder) { IncludeSubdirectories = false,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size };
        watcher.Created += Changed; watcher.Changed += Changed; watcher.Renamed += Changed; watcher.Deleted += Changed;
        watcher.Error += (_, _) => workspaceChanges[source.Id] = "!overflow";
        try { watcher.EnableRaisingEvents = true; workspaceWatchers.Add(source.Id, watcher); }
        catch { watcher.Dispose(); throw; }
        void Changed(object sender, FileSystemEventArgs e)
        {
            workspaceChanges.TryAdd(source.Id, e.Name ?? "");
        }
    }

    private static JsonElement[] WorkspaceRecords(WorkspaceSource source, SourceReadResult parsed)
    {
        if (source.ConfirmedWorkflow != null) return SourceReaders.NormalizeWorkflow(parsed, source.Id, source.ConfirmedWorkflow).EnumerateArray().ToArray();
        if (source.ConfirmedMap != null && source.Roles.Contains("order"))
            return SourceReaders.NormalizeOrderLines(parsed, source.Id, source.ConfirmedMap).EnumerateArray().ToArray();
        if (source.Roles.Count == 0 || source.Roles.Count > 1 && parsed.Rows.Any(r => !r.Fields.ContainsKey("kind"))) return [];
        return source.Roles.SelectMany(role => SourceReaders.Normalize(parsed, role).EnumerateArray())
            .DistinctBy(record => record.GetRawText()).ToArray();
    }

    private void InspectWorkspaceSource(WorkspaceSource source)
    {
        try
        {
            ValidateProofSourceFolder(source.Folder);
            var path = FolderSource.ValidateWorkspaceRoot(source.Folder);
            var names = WorkspaceFiles(path);
            if (names.Length == 0)
            {
                source.Recognition = Json.Element(new { state = "empty", message = "Waiting for the first report.", fields = Array.Empty<string>() });
                source.Issue = null;
                return;
            }
            JsonElement? first = null;
            source.ProposedMap = null;
            source.ProposedWorkflow = null;
            foreach (var name in names.Take(6))
            {
                try
                {
                    var parsed = SourceReaders.Read(name, FolderSource.WorkspaceSnapshot(path, name));
                    var mapped = WorkspaceRecords(source, parsed);
                    var preview = parsed.Rows.FirstOrDefault()?.Fields
                        .Where(pair => pair.Value.ValueKind is JsonValueKind.String or JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False)
                        .Take(8).ToDictionary(pair => pair.Key, pair => string.Concat(pair.Value.ToString().Take(128)));
                    if (mapped.Length == 0 && source.ConfirmedMap == null && source.Roles.SequenceEqual(new[] { "order" })
                        && SourceReaders.ProposeOrderMap(parsed) is { } proposal &&
                        SourceReaders.NormalizeOrderLines(parsed, source.Id, proposal).GetArrayLength() > 0)
                    {
                        source.ProposedMap = proposal;
                        var profileVersion = SourceReaders.OrderProfileVersion(proposal);
                        source.Recognition = Json.Element(new { state = "ambiguous", message = $"Read order lines, quantities, units and versions from {name}.",
                            question = $"Does {proposal.Order} identify the sales order in this report?",
                            suggestedOrderColumn = proposal.Order, profileVersion, fields = parsed.Headers.Take(16), sample = preview, fileName = name });
                        return;
                    }
                    if (mapped.Length == 0 && InspectWorkflowColumns(source, parsed, name, preview)) return;
                    var detected = parsed.Headers.Take(16).Select(h => string.Concat(h.Take(80))).ToArray();
                    var recognized = mapped.Length > 0 || source.Roles.Contains("evidence") && parsed.State is "recognized" or "parsed";
                    var recognition = Json.Element(new { state = recognized ? "recognized" : parsed.State is "parsed" or "ambiguous" ? "ambiguous" : parsed.State == "incomplete" ? "incomplete" : "unsupported",
                        message = mapped.Length > 0 ? $"Found {mapped.Length} record(s) in {name}." :
                            recognized ? $"Found evidence in {name}. An explicit link is needed to attach it to an order." :
                            parsed.State is "parsed" or "ambiguous" ? $"Read {name}. Its order or event references need a confirmed profile." :
                            parsed.Issues.FirstOrDefault() ?? "This file needs a supported reader.",
                        fields = detected, sample = preview, fileName = name, checkedFilesLimit = 6 });
                    if (recognized)
                    {
                        var namespaces = mapped.Select(m => Optional(Optional(m,"entity"),"namespace")?.GetString()).OfType<string>().Distinct().ToArray();
                        source.ObservedNamespace = namespaces.Length == 1 ? namespaces[0] : null;
                        source.Recognition = recognition; source.Issue = null; return;
                    }
                    first ??= recognition;
                }
                catch (ConnectException e) { first ??= Json.Element(new { state = "unavailable", message = e.Message, fields = Array.Empty<string>() }); }
            }
            source.Recognition = first;
        }
        catch (Exception e) when (e is ConnectException or IOException or UnauthorizedAccessException)
        {
            source.Issue = e is ConnectException ce ? ce.Code : "SOURCE_UNREADABLE";
            source.Recognition = Json.Element(new { state = "unavailable", message = "The service could not read this folder. Check the location and its access, then try again.", fields = Array.Empty<string>() });
        }
    }

    private async Task TickWorkspace(CancellationToken ct)
    {
        var w = state.Workspace;
        if (w is null || !CurrentInstallation || w.ActiveGrant is null && w.Phase != "awaiting_approval")
        {
            StopWorkspaceWatchers();
            return;
        }
        var now = DateTimeOffset.UtcNow;
        if (networkOnline && now >= nextWorkspacePoll)
        {
            nextWorkspacePoll = now.AddSeconds(w.Phase == "active" ? 12 : 3);
            try
            {
                if (w.ScopeDigest is not null) await PollWorkspace(w, ct);
                else if (w.ActiveGrant is { } grant)
                {
                    var result = await api.Request("GET", WorkspaceApi, null, state.Token, null, ct);
                    if (Optional(result,"scopeDigest")?.GetString() == grant.ScopeDigest && Optional(result,"state")?.GetString() == "active")
                        w.ActiveGrant = grant with { CheckedAt = DateTimeOffset.UtcNow };
                    else if (Optional(result,"state")?.GetString() != "pending") w.ActiveGrant = null;
                }
            }
            catch (Exception e) when (e is ApiException or HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
            {
                networkOnline = false; ordersCurrent = false;
                if (e is ApiException a && a.Status is 401 or 403 or 404)
                {
                    w.ActiveGrant = null; w.Invalidate(); w.Attention = "Reconnect this computer and review its approved locations.";
                    Save(); StopWorkspaceWatchers(); return;
                }
                w.Attention = "Waiting for PackProof. Collection resumes within the approved window.";
            }
        }
        if (!WorkspaceGrantCurrent) { StopWorkspaceWatchers(); return; }
        if (networkOnline && now >= nextOrderRefresh)
        {
            nextOrderRefresh = now.AddSeconds(3);
            try
            {
                var snap = await api.Request("GET", "/v1/partner/agent/order-proofs", null, state.Token, null, ct);
                workspaceOrders = snap.GetProperty("orders").EnumerateArray().Take(20).Select(order => Json.Element(new
                {
                    proofId = order.GetProperty("proofId"), revision = order.GetProperty("revision"),
                    orderReference = Optional(order, "orderReference"), updatedAt = Optional(order, "updatedAt")
                })).ToArray();
                ordersScope = w.ActiveGrant?.ScopeDigest; ordersCurrent = true;
            }
            catch (Exception e) when (e is ApiException or HttpRequestException or JsonException or KeyNotFoundException or TaskCanceledException && !ct.IsCancellationRequested)
            {
                ordersCurrent = false;
                if (e is ApiException denied && denied.Status is 401 or 403) { w.ActiveGrant = null; w.Invalidate(); w.Attention = "Access changed. Review the connection again."; Save(); return; }
            }
        }
        if (networkOnline) await ReconcilePartnerHistory(w, ct);
        var active = w.Sources.Where(s => s.Transport == "folder" && !s.Paused && w.ActiveGrant!.Generations.GetValueOrDefault(s.Id) == s.Generation).ToArray();
        foreach (var id in workspaceWatchers.Keys.Where(id => !active.Any(s => s.Id == id)).ToArray()) DropWatcher(id);
        if (active.Length == 0) return;
        var offset = (Array.FindIndex(active, s => s.Id == w.LastScheduled) + 1) % active.Length;
        for (var i = 0; i < Math.Min(4, active.Length); i++)
        {
            ct.ThrowIfCancellationRequested();
            var source = active[(offset+i)%active.Length];
            w.LastScheduled = source.Id;
            if (source.RetryAt > now) continue;
            try
            {
                if (networkOnline) await SubmitOneWorkspaceOriginal(w, source, ct);
                if (!WorkspaceGrantCurrent) break;
                CaptureWorkspaceTurn(w,source,now);
            }
            catch (Exception e) when (e is IOException or ConnectException or UnauthorizedAccessException)
            {
                source.Issue = e is ConnectException ce ? ce.Code : "SOURCE_UNREADABLE";
                source.CoverageGap = true;
                source.RetryAt = now.AddSeconds(10);
                DropWatcher(source.Id);
            }
        }
        await AdvanceWorkspaceMedia(w,ct);
        Save();
    }

    private DateTimeOffset nextPartnerHistory;
    private async Task ReconcilePartnerHistory(OrderWorkspaceState w, CancellationToken ct)
    {
        var grant = w.ActiveGrant!;
        var now = DateTimeOffset.UtcNow;
        if (now < nextPartnerHistory) return;
        var source = w.Sources.FirstOrDefault(s => s.Transport == "api" && !s.Paused && grant.Generations.GetValueOrDefault(s.Id) == s.Generation &&
            (s.ApiHistoryState != "current" || s.ApiHistoryGeneration != s.Generation) && !(s.RetryAt > now));
        if (source == null) return;
        nextPartnerHistory = now.AddSeconds(5);
        try
        {
            var reply = await api.Request("POST",WorkspaceApi+"/reconcile-api-source",
                new { sourceId=source.Id,generation=source.Generation,scopeDigest=grant.ScopeDigest },state.Token,null,ct);
            source.ApiHistoryState = reply.GetProperty("state").GetString();
            source.ApiHistoryGeneration = source.Generation;
            if (source.ApiHistoryState == "source_reference_needed")
            {
                source.Issue = "SOURCE_REFERENCE_NEEDED";
                source.RetryAt = now.AddMinutes(5);
            }
            else if (source.ApiHistoryState == "paused") source.Paused = true;
            else source.Issue = null;
            Save();
        }
        catch (Exception error) when (error is ApiException or HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            source.Issue = error is ApiException a ? a.Code : "NETWORK_UNAVAILABLE";
            source.RetryAt = now.AddMinutes(1);
            Save();
        }
    }

    private void CaptureWorkspaceTurn(OrderWorkspaceState w, WorkspaceSource s, DateTimeOffset now)
    {
        ValidateCollectingProofSource(s.Folder);
        var folder = FolderSource.ValidateWorkspaceRoot(s.Folder);
        using var pin = new ProofOutputPaths.DirectoryPin(folder);
        if (s.PhysicalRoot is { } expected && pin.KeyStrings.FirstOrDefault() != expected)
            throw new ConnectException("SOURCE_REPLACED", "This folder was replaced. Select it again and approve the new location.");
        MonitorWorkspaceSource(s); // Boundary first, reconciliation second.
        workspaceChanges.TryRemove(s.Id, out var changed);
        if (changed == "!overflow") s.CoverageGap = true;
        if (changed is null && s.LastScanAt > now.AddSeconds(-15)) return;
        var names = WorkspaceFiles(folder);
        var batch = names.Where(n => string.Compare(n, s.Cursor, StringComparison.OrdinalIgnoreCase) > 0).Take(4).ToArray();
        if (batch.Length == 0) batch = names.Take(4).ToArray();
        if (!string.IsNullOrEmpty(changed) && names.Contains(changed, StringComparer.OrdinalIgnoreCase) && !batch.Contains(changed, StringComparer.OrdinalIgnoreCase))
            CaptureWorkspaceFile(w,s,folder,changed);
        foreach (var name in batch)
        {
            // A single bad report cannot starve the folder: advance the traversal
            // cursor, not the durable file version, when a particular file is busy.
            try { CaptureWorkspaceFile(w,s,folder,name); }
            catch (ConnectException e) when (e.Code is "SOURCE_BUSY" or "SOURCE_READ_FAILED" or "SOURCE_SIZE_UNSUPPORTED" or "SOURCE_ACCESS_DENIED")
            { s.Issue = e.Code; }
            s.Cursor = name;
        }
        s.LastScanAt = batch.Length == 0 || names[^1] == batch[^1] ? now : null;
    }

    private void CaptureWorkspaceFile(OrderWorkspaceState w, WorkspaceSource s, string folder, string name)
    {
        var bytes = FolderSource.WorkspaceSnapshot(folder, name);
        var digest = HashBytes(bytes);
        var key = name.ToUpperInvariant();
        var previous = s.Inventory.GetValueOrDefault(key);
        if (previous?.Digest == digest && previous.Generation == s.Generation) return;
        if (previous is null && s.Inventory.Count >= SourceDirectoryLimit) throw new ConnectException("SOURCE_CAPACITY_REACHED", "The retained inventory needs a new approved folder or a retention review.");
        var sequence = checked((previous?.Sequence ?? 0) + 1);
        var obs = Hash(JsonSerializer.Serialize(new { installation = w.ActiveGrant!.InstallationId, s.Id, s.Generation, key, sequence, digest }));
        var parsed = SourceReaders.Read(name, bytes);
        var dependenciesCurrent = s.ConfirmedDependencies.All(d => w.Sources.Any(t => t.Id == d.Key && t.Roles.Count > 0 && t.Generation == d.Value));
        var records = dependenciesCurrent ? WorkspaceRecords(s, parsed) : [];
        if (!dependenciesCurrent) s.Issue = "RELATED_SOURCE_CHANGED";
        var issues = parsed.Issues.Take(8).ToList();
        var awaitingSidecar = records.Length == 0 && (SourceReaders.IsMedia(name) || parsed.Format is "zpl" or "prn")
            && parsed.State is "recognized" or "parsed";
        if (awaitingSidecar) issues.Clear();
        if (!awaitingSidecar && records.Length == 0 && issues.Count == 0) issues.Add("This report needs a confirmed order or package reference.");
        var body = Json.Element(new { sourceId = s.Id, generation = s.Generation, scopeDigest = w.ActiveGrant!.ScopeDigest,
            fileName = name, originalSha256 = digest, originalBase64 = Convert.ToBase64String(bytes), mediaType = WorkspaceMediaType(name),
            profileVersion = s.ProfileVersion, observationId = obs, records, issues });
        if (records.Length > 512 || Json.Bytes(body).Length > 6 * 1024 * 1024)
            body = Json.Element(new { sourceId = s.Id, generation = s.Generation, scopeDigest = w.ActiveGrant!.ScopeDigest, fileName = name,
                originalSha256 = digest, originalBase64 = Convert.ToBase64String(bytes), mediaType = WorkspaceMediaType(name),
                profileVersion = s.ProfileVersion, observationId = obs, records = Array.Empty<object>(), issues = new[]{"Interpretation exceeds the bounded request size. The original needs review."} });
        var staged = queue.StageWorkspace(bytes, name, body, w.ActiveGrant!.InstallationId, obs, s);
        if (SourceReaders.IsMedia(name) && !s.MediaJobs.Contains(staged.Id)) s.MediaJobs.Add(staged.Id);
        s.Inventory[key] = new(digest, sequence, s.Generation, name);
        if (records.Length == 0) s.Issue = "IDENTITY_UNRESOLVED";
        else if (s.Issue is "SOURCE_UNREADABLE" or "SOURCE_BUSY" or "SOURCE_READ_FAILED" or "SOURCE_ACCESS_DENIED") s.Issue = null;
        Save(); // Never checkpoint before durable staging. Replay reconstructs the same logical observation.
    }

    private async Task SubmitOneWorkspaceOriginal(OrderWorkspaceState w, WorkspaceSource source, CancellationToken ct)
    {
        var entry = queue.NextWorkspace(source,w.ActiveGrant!.InstallationId,DateTimeOffset.UtcNow);
        if (entry is null) return;
        var payload = queue.Payload(entry);
        var wire = payload.PreviewWireBody ?? throw new ConnectException("WORKSPACE_PAYLOAD_MISSING","The retained original is unavailable. Preserve the queue and contact support.");
        var originalScope = Json.Read<JsonElement>(wire).GetProperty("scopeDigest").GetString();
        if (originalScope != w.ActiveGrant!.ScopeDigest)
        {
            queue.Save(entry, payload, "action_needed", error:"WORKSPACE_SCOPE_CHANGED");
            source.Issue = "WORKSPACE_SCOPE_CHANGED"; return;
        }
        try
        {
            var receipt = await api.Request("POST", WorkspaceApi + "/observations", new ExactJsonBody(wire, payload.PreviewBodySha256!),
                state.Token, entry.PreviewKey, ct);
            var status = receipt.GetProperty("state").GetString();
            if (status is not ("accepted" or "pending") || receipt.GetProperty("originalSha256").GetString() != entry.Digest
                || string.IsNullOrEmpty(receipt.GetProperty("receiptId").GetString()))
                throw new ConnectException("RECEIPT_MISMATCH","The server receipt does not identify the captured original. Preserve the queue and retry.");
            payload.Receipt = receipt;
            queue.Save(entry,payload,"complete",importId:receipt.GetProperty("receiptId").GetString());
            if (status == "pending") source.Issue = "IDENTITY_UNRESOLVED";
            ordersCurrent = false; nextOrderRefresh = DateTimeOffset.MinValue;
        }
        catch (Exception e) when (e is ApiException or HttpRequestException or ConnectException or JsonException or InvalidOperationException or KeyNotFoundException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            var code = e is ApiException remote ? remote.Code : e is ConnectException local ? local.Code : e is HttpRequestException or TaskCanceledException ? "NETWORK_UNAVAILABLE" : "RECEIPT_INVALID";
            var retry = e is HttpRequestException or TaskCanceledException || e is ApiException transient && transient.Transient;
            queue.Save(entry,payload,retry ? "staged" : "action_needed",error:code,failed:retry,retryAfter:(e as ApiException)?.RetryAfter);
            source.Issue = code;
            if (e is ApiException denied && denied.Status is 401 or 403) { w.ActiveGrant = null; w.Invalidate(); w.Attention = "Access changed. Review the current locations."; }
        }
    }

    private static string WorkspaceMediaType(string name) => Path.GetExtension(name).ToLowerInvariant() switch
    {
        ".csv" => "text/csv", ".json" or ".jsonld" => "application/json", ".jsonl" or ".ndjson" => "application/x-ndjson",
        ".xml" => "application/xml", ".pdf" => "application/pdf", ".jpg" or ".jpeg" => "image/jpeg", ".png" => "image/png",
        ".tif" or ".tiff" => "image/tiff", ".webp" => "image/webp", ".heic" => "image/heic", _ => "application/octet-stream"
    };
    private void DropWatcher(string id)
    {
        if (workspaceWatchers.Remove(id, out var watcher)) watcher.Dispose();
        workspaceChanges.TryRemove(id,out _);
    }
    private void StopWorkspaceWatchers() { foreach (var id in workspaceWatchers.Keys.ToArray()) DropWatcher(id); }
}

