using System.Collections.Concurrent;
using System.Text.Json;

namespace PackProof.Connect;

public sealed partial class AgentRuntime
{
    // Callbacks only mark a folder dirty. Reconciliation and immutable admission run
    // on the serialized service lane. A wakeup can be lost without losing the cursor.
    private readonly Dictionary<string,FileSystemWatcher> workspaceWatchers = [];
    private sealed class FolderNotifications
    {
        private readonly HashSet<string> pending = new(StringComparer.OrdinalIgnoreCase);
        private bool overflow;
        public void Add(string? name)
        {
            lock (pending)
            {
                if (string.IsNullOrEmpty(name) || pending.Count >= 256) overflow = true;
                else pending.Add(name);
            }
        }
        public (string[] Names,bool Gap) Take()
        {
            lock (pending)
            {
                var names = pending.Take(8).ToArray();
                foreach(var name in names) pending.Remove(name);
                var gap = overflow; overflow=false;
                return (names,gap);
            }
        }
    }
    private readonly ConcurrentDictionary<string,FolderNotifications> workspaceChanges = new();
    private readonly Dictionary<string,(string Scope, int Generation, bool Failed, DateTimeOffset RetryAt)> reportedChecks = [];
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
        var notices = workspaceChanges.GetOrAdd(source.Id,_ => new FolderNotifications());
        watcher.Created += Changed; watcher.Changed += Changed; watcher.Deleted += Changed;
        watcher.Renamed += (_, e) => { notices.Add(e.OldName); notices.Add(e.Name); WakeService(); };
        watcher.Error += (_, _) => { notices.Add(null); WakeService(); };
        try { watcher.EnableRaisingEvents = true; workspaceWatchers.Add(source.Id, watcher); }
        catch (IOException) { watcher.Dispose(); source.CoverageGap = true; } // Some shares support listing only.
        catch { watcher.Dispose(); throw; }
        void Changed(object sender, FileSystemEventArgs e)
        {
            notices.Add(e.Name);
            WakeService();
        }
    }

    internal static JsonElement[] WorkspaceRecords(WorkspaceSource source, SourceReadResult parsed)
    {
        var export = SourceReaders.RecognizeExport(parsed, out bool ambiguous);
        if (ambiguous) return [];
        if (source.PackingReader is { } packingReader) return SourceReaders.NormalizeFacilityPacking(parsed,packingReader);
        var candidates = new List<JsonElement[]>();
        if (source.ConfirmedMap != null && source.Roles.Contains("order"))
        {
            var orderLines = SourceReaders.NormalizeOrderLines(parsed, source.Id, source.ConfirmedMap).EnumerateArray().ToArray();
            if (orderLines.Length > 0) candidates.Add(orderLines);
        }
        // A known vendor order layout must pass its approved company, status and revision rules.
        // Supplementary canonical-looking fields cannot bypass a missing or rejected mapping.
        if (export?.OrderColumns != null && candidates.Count == 0 && (source.ConfirmedMap == null || source.ConfirmedMap.Catalogue != null))
            return [];
        foreach (var workflow in source.ApprovedWorkflows())
        {
            var matches = SourceReaders.NormalizeWorkflow(parsed,source.Id,workflow,source.ShippedAtMeaning).EnumerateArray().ToArray();
            if (matches.Length > 0) candidates.Add(matches);
        }
        // An ambiguous file may not be applied independently to two workflow stages.
        if (candidates.Count > 0) return candidates.Count == 1 ? candidates[0] : [];
        if (source.Roles.Count == 0 || source.Roles.Count > 1 && parsed.Rows.Any(r => !r.Fields.ContainsKey("kind"))) return [];
        return source.Roles.Where(role => role != "order" || source.ConfirmedMap?.Catalogue == null)
            .SelectMany(role => SourceReaders.Normalize(parsed, role).EnumerateArray())
            .DistinctBy(record => record.GetRawText()).ToArray();
    }

    // Only reorder basenames from the validated folder inventory. A hint cannot
    // introduce a path or expand the existing sample budget.
    internal static IEnumerable<string> PrioritizeSample(string[] names, string? sample)
    {
        var index = Array.FindIndex(names, name => string.Equals(name, sample, StringComparison.OrdinalIgnoreCase));
        if (index <= 0) return names;
        return names.Skip(index).Take(1).Concat(names.Take(index)).Concat(names.Skip(index + 1));
    }

    private void InspectWorkspaceSource(WorkspaceSource source, string? sampleFile = null)
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
            JsonElement? first = null, exportGuidance = null;
            source.ProposedMap = null;
            source.ProposedWorkflow = null;
            sampleFile ??= Optional(source.Recognition, "fileName")?.GetString();
            foreach (var name in PrioritizeSample(names, sampleFile).Take(6))
            {
                try
                {
                    var parsed = SourceReaders.Read(name, FolderSource.WorkspaceSnapshot(path, name));
                    var mapped = WorkspaceRecords(source, parsed);
                    var vendor = SourceReaders.RecognizeExport(parsed);
                    if (vendor?.Role != (source.InspectRole ?? source.Roles.LastOrDefault())) vendor = null;
                    var requestedKind = source.InspectRole switch { "shipping" => "label", "returns" => "return", var r => r };
                    if (requestedKind != null && source.Roles.Count > 1)
                        mapped = mapped.Where(r=>Optional(r,"kind")?.GetString() is { } k && (k==requestedKind || k=="correction")).ToArray();
                    var preview = parsed.Rows.FirstOrDefault()?.Fields
                        .Where(pair => pair.Value.ValueKind is JsonValueKind.String or JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False)
                        .Take(8).ToDictionary(pair => pair.Key, pair => string.Concat(pair.Value.ToString().Take(128)));
                    if (mapped.Length == 0 && source.ConfirmedMap == null && (source.InspectRole ?? source.Roles.LastOrDefault()) == "order"
                        && SourceReaders.ProposeOrderMap(parsed) is { } proposal &&
                        SourceReaders.NormalizeOrderLines(parsed, source.Id, proposal).GetArrayLength() > 0)
                    {
                        source.ProposedMap = proposal;
                        var profileVersion = SourceReaders.OrderProfileVersion(proposal);
                        var question = proposal.Catalogue is { } scope
                            ? $"Does {proposal.Order} identify the order for company {scope.Company}?"
                            : $"Does {proposal.Order} identify the sales order in this report?";
                        source.Recognition = Json.Element(new { state = "ambiguous", message = vendor == null
                            ? $"Read order lines, quantities, units and versions from {name}."
                            : $"Found {vendor.Label} in {name}.", question,
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
                        fields = detected, sample = preview, fileName = name, checkedFilesLimit = 6,
                        packingSchema = source.Roles.SequenceEqual(["packing"]) && parsed.State=="parsed" && vendor==null ? SourceReaders.PackingSchema(parsed) : null });
                    if (recognized)
                    {
                        var namespaces = mapped.Select(m => Optional(Optional(m,"entity"),"namespace")?.GetString()).OfType<string>().Distinct().ToArray();
                        source.ObservedNamespace = namespaces.Length == 1 ? namespaces[0] : null;
                        source.Recognition = recognition; source.Issue = null; return;
                    }
                    if (vendor != null)
                        exportGuidance ??= Json.Element(new { state = "ambiguous", message = $"Found {vendor.Label} in {name}. {vendor.Guidance}",
                            fields = detected, fileName = name, checkedFilesLimit = 6 });
                    first ??= recognition;
                }
                catch (ConnectException e) { first ??= Json.Element(new { state = "unavailable", message = e.Message, fields = Array.Empty<string>() }); }
            }
            source.Recognition = exportGuidance ?? first;
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
                    var result = await api.Request("GET", WorkspaceApi+"?scopeDigest="+grant.ScopeDigest, null, state.Token, null, ct);
                    if (Optional(result,"scopeDigest")?.GetString() == grant.ScopeDigest && Optional(result,"state")?.GetString() == "active")
                        w.ActiveGrant = grant with { CheckedAt = DateTimeOffset.UtcNow };
                    else if (Optional(result,"state")?.GetString() != "pending") w.ActiveGrant = null;
                }
            }
            catch (ApiException limited) when (limited.Status == 429)
            {
                // Keep the existing grant and its original expiry. A busy policy
                // endpoint must not stop independently authorized queue or output work.
                nextWorkspacePoll = DurableQueue.RetryAt(now,2,limited.RetryAfter);
                w.Attention = "PackProof is busy. Retrying the connection.";
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
        // All prior uploads drained before submission. Leave source checkpoints intact until
        // the browser chooses which scope may admit newly arrived files.
        if(w.SubmittedProfileDigest is not null && w.Phase=="awaiting_approval") return;
        if (networkOnline) await ReconcilePartnerHistory(w, ct);
        var active = w.Sources.Where(s => s.Transport == "folder" && !s.Paused && w.ActiveGrant!.Generations.GetValueOrDefault(s.Id) == s.Generation).ToArray();
        foreach (var id in workspaceWatchers.Keys.Where(id => !active.Any(s => s.Id == id)).ToArray()) DropWatcher(id);
        if (active.Length == 0) { await RefreshWorkspaceOrders(w,ct); return; }
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
                if (source.Issue is "SOURCE_UNREADABLE" or "SOURCE_REPLACED" or "SOURCE_ACCESS_DENIED" or "SOURCE_READ_FAILED" or "SOURCE_BUSY")
                {
                    source.LastCheckAttemptAt = receiptClock.GetUtcNow();
                    source.LastReadFailed = true;
                }
                source.CoverageGap = true;
                source.RetryAt = now.AddSeconds(10);
                DropWatcher(source.Id);
            }
            if(networkOnline && w.ActiveGrant?.TestedProfileDigest!=null && GuidedSetupAvailable && WorkspaceGrantCurrent)
                await ReportSourceCheck(w.ActiveGrant!,source,now,ct);
        }
        if (!WorkspaceGrantCurrent) return;
        await RefreshWorkspaceOrders(w,ct);
        if (!WorkspaceGrantCurrent) return;
        await AdvanceWorkspaceMedia(w,ct);
        if (now >= nextWorkspaceCheckpoint)
        {
            nextWorkspaceCheckpoint = now.AddSeconds(10);
            Save();
        }
    }

    private async Task ReportSourceCheck(WorkspaceGrant grant, WorkspaceSource source, DateTimeOffset now, CancellationToken ct)
    {
        if (source.LastCheckAttemptAt is not { } checkedAt) return;
        if (reportedChecks.TryGetValue(source.Id, out var prior) && prior.Scope==grant.ScopeDigest &&
            prior.Generation==source.Generation && prior.Failed==source.LastReadFailed && prior.RetryAt>now) return;
        // Send outages and recoveries immediately. Coalesce routine reads to stay
        // within the installation's request budget, including after an API failure.
        var interval=TimeSpan.FromSeconds(45);
        try
        {
            await api.Request("POST",WorkspaceApi+"/source-health",new {scopeDigest=grant.ScopeDigest,sourceId=source.Id,
                generation=source.Generation,checkedAt,lastVerifiedReadAt=Json.Element(source.LastVerifiedReadAt),
                state=source.LastReadFailed?"unreadable":"current"},state.Token,null,ct);
        }
        catch(Exception ex) when(ex is ApiException or HttpRequestException || ex is TaskCanceledException && !ct.IsCancellationRequested)
        {
            interval=ex is ApiException {RetryAfter: { } delay} && delay>interval?delay:interval;
        }
        reportedChecks[source.Id]=(grant.ScopeDigest,source.Generation,source.LastReadFailed,now.Add(interval));
    }

    private DateTimeOffset earliestReceiptRefresh;
    private async Task RefreshWorkspaceOrders(OrderWorkspaceState w, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        if (networkOnline && now >= nextOrderRefresh)
        {
            // Intake and the desktop share the installation's request budget. Multiple
            // accepted originals can be covered by the same authoritative snapshot.
            nextOrderRefresh = now.AddMilliseconds(1250);
            earliestReceiptRefresh = now.AddMilliseconds(850);
            try
            {
                var dayStart=DateTime.Today.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'",System.Globalization.CultureInfo.InvariantCulture);
                var snap = await api.Request("GET","/v1/partner/agent/order-proofs?dayStart="+Uri.EscapeDataString(dayStart),null,state.Token,null,ct);
                workspaceOrders = snap.GetProperty("orders").EnumerateArray().Take(20).Select(SummaryForDesktop).ToArray();
                orderPageCursor = OrderCursor(snap);
                totalOrders = OptionalCount(snap,"totalOrders");
                updatedToday = OptionalCount(snap,"updatedToday");
                updatedLast24Hours = OptionalCount(snap,"updatedLast24Hours");
                ordersScope = w.ActiveGrant?.ScopeDigest; ordersCurrent = true;
                if (w.Sources.Any(s=>s.Issue=="IDENTITY_UNRESOLVED") && now >= nextReferenceRefresh)
                {
                    nextReferenceRefresh=now.AddSeconds(5);
                    var attention=await api.Request("GET","/v1/partner/agent/order-attention",null,state.Token,null,ct);
                    if (attention.GetProperty("hasMore").ValueKind == JsonValueKind.False)
                    {
                        var unresolved=attention.GetProperty("items").EnumerateArray().Select(x=>x.GetProperty("sourceId").GetString()).ToHashSet();
                        foreach(var source in w.Sources.Where(s=>s.Issue=="IDENTITY_UNRESOLVED" && !unresolved.Contains(s.Id))) source.Issue=null;
                    }
                }
            }
            catch (Exception e) when (e is ApiException or HttpRequestException or JsonException or KeyNotFoundException or TaskCanceledException && !ct.IsCancellationRequested)
            {
                ordersCurrent = false;
                if (e is ApiException { Status:429 } limited)
                    earliestReceiptRefresh = nextOrderRefresh = DurableQueue.RetryAt(DateTimeOffset.UtcNow,2,limited.RetryAfter);
                if (e is ApiException denied && denied.Status is 401 or 403) { w.ActiveGrant = null; w.Invalidate(); w.Attention = "Access changed. Review the connection again."; Save(); return; }
            }
        }
    }

    private DateTimeOffset nextReferenceRefresh;
    private DateTimeOffset nextWorkspaceCheckpoint;
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
        var (changed,gap) = workspaceChanges.GetOrAdd(s.Id,_=>new FolderNotifications()).Take();
        if (gap) s.CoverageGap = true;
        if (!gap && changed.Length==0 && s.LastScanAt > now.AddSeconds(-15)) return;
        var names = WorkspaceFiles(folder);
        var present = names.ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var key in s.Inventory.Keys.Where(k=>!present.Contains(k) && !s.Inventory[k].Missing).ToArray())
            s.Inventory[key] = s.Inventory[key] with {Missing=true};
        if (changed.Any(n=>!present.Contains(n) && !s.Inventory.ContainsKey(n.ToUpperInvariant()) && !n.EndsWith(".tmp",StringComparison.OrdinalIgnoreCase)))
            s.CoverageGap = true;
        var batch = names.Where(n => string.Compare(n, s.Cursor, StringComparison.OrdinalIgnoreCase) > 0).Take(4).ToArray();
        if (batch.Length == 0) batch = names.Take(4).ToArray();
        var prioritized = changed.Where(n=>present.Contains(n)).Concat(batch).Distinct(StringComparer.OrdinalIgnoreCase);
        bool failureChanged = false;
        // A producer can remove a failed report before we obtain its bytes. Keep the
        // coverage gap visible rather than manufacturing a successful observation.
        foreach (var key in s.PendingReadFailures.Keys.Where(key=>!present.Contains(key)).ToArray())
        {
            s.PendingReadFailures.Remove(key);
            s.CoverageGap = true;
            failureChanged = true;
        }
        foreach (var name in prioritized)
        {
            // A single bad report cannot starve the folder: advance the traversal
            // cursor, not the durable file version, when a particular file is busy.
            var key = name.ToUpperInvariant();
            try
            {
                CaptureWorkspaceFile(w,s,folder,name);
                failureChanged |= s.PendingReadFailures.Remove(key);
            }
            catch (ConnectException e) when (e.Code is "SOURCE_BUSY" or "SOURCE_READ_FAILED" or "SOURCE_SIZE_UNSUPPORTED" or "SOURCE_ACCESS_DENIED")
            {
                failureChanged |= s.PendingReadFailures.GetValueOrDefault(key) != e.Code;
                s.PendingReadFailures[key] = e.Code;
            }
        }
        if (batch.Length > 0) s.Cursor = batch[^1];
        s.LastScanAt = batch.Length == 0 || names[^1] == batch[^1] ? now : null;
        s.LastCheckAttemptAt = receiptClock.GetUtcNow();
        s.LastReadFailed = s.PendingReadFailures.Count > 0;
        if (s.LastReadFailed)
        {
            // Keep attention and the previous verified-read timestamp until the
            // specific unreadable files have been reopened or removed.
            // Other independent incidents (for example a pending interpretation or
            // upload) must survive the read recovery. WorkspaceView projects the
            // retained file failure first, even if another operation sets Issue.
            if (s.Issue is null or "SOURCE_UNREADABLE" or "SOURCE_ACCESS_DENIED" or "SOURCE_READ_FAILED" or "SOURCE_BUSY" or "SOURCE_SIZE_UNSUPPORTED")
                s.Issue = s.PendingReadIssue();
        }
        else
        {
            s.LastVerifiedReadAt = s.LastCheckAttemptAt;
            s.RetryAt = null;
            // Only clear a read incident after reopening the source and completing a read.
            // File interpretations and pending receipts have independent recovery conditions.
            if (s.Issue is "SOURCE_UNREADABLE" or "SOURCE_ACCESS_DENIED" or "SOURCE_READ_FAILED" or "SOURCE_BUSY" or "SOURCE_SIZE_UNSUPPORTED")
                s.Issue = null;
        }
        if (failureChanged) Save();
    }

    private void CaptureWorkspaceFile(OrderWorkspaceState w, WorkspaceSource s, string folder, string name)
    {
        var bytes = FolderSource.WorkspaceSnapshot(folder, name);
        var firstSeenAt = receiptClock.GetUtcNow();
        var digest = HashBytes(bytes);
        var key = name.ToUpperInvariant();
        var previous = s.Inventory.GetValueOrDefault(key);
        if (previous?.Digest == digest && previous.Generation == s.Generation && !previous.Missing) return;
        if (previous is null && s.Inventory.Count >= SourceDirectoryLimit) throw new ConnectException("SOURCE_CAPACITY_REACHED", "The retained inventory needs a new approved folder or a retention review.");
        var sequence = checked((previous?.Sequence ?? 0) + 1);
        var obs = Hash(JsonSerializer.Serialize(new { installation = w.ActiveGrant!.InstallationId, s.Id, s.Generation, key, sequence, digest }));
        var parsed = SourceReaders.Read(name, bytes);
        var dependenciesCurrent = s.ConfirmedDependencies.All(d => w.Sources.Any(t => t.Id == d.Key && t.Roles.Count > 0 && t.Generation == d.Value))
            && (s.PackingReader is not { } custom || w.Sources.Any(t=>t.Id==custom.Rule.OrderSourceId && t.Roles.Contains("order") && t.Generation==custom.OrderGeneration));
        var records = dependenciesCurrent ? WorkspaceRecords(s, parsed) : [];
        if (!dependenciesCurrent) s.Issue = "RELATED_SOURCE_CHANGED";
        var issues = parsed.Issues.Take(8).ToList();
        var awaitingSidecar = records.Length == 0 && (SourceReaders.IsMedia(name) || parsed.Format is "zpl" or "prn")
            && parsed.State is "recognized" or "parsed";
        if (awaitingSidecar) issues.Clear();
        if (!awaitingSidecar && records.Length == 0 && issues.Count == 0) issues.Add("This report needs a confirmed order or package reference.");
        var body = Json.Element(new { sourceId = s.Id, generation = s.Generation, scopeDigest = w.ActiveGrant!.ScopeDigest,
            fileName = name, originalSha256 = digest, originalBase64 = Convert.ToBase64String(bytes), mediaType = WorkspaceMediaType(name),
            profileVersion = s.ProfileVersion, observationId = obs, firstSeenAt, records, issues });
        if (records.Length > 512 || Json.Bytes(body).Length > 6 * 1024 * 1024)
            body = Json.Element(new { sourceId = s.Id, generation = s.Generation, scopeDigest = w.ActiveGrant!.ScopeDigest, fileName = name,
                originalSha256 = digest, originalBase64 = Convert.ToBase64String(bytes), mediaType = WorkspaceMediaType(name),
                profileVersion = s.ProfileVersion, observationId = obs, firstSeenAt, records = Array.Empty<object>(), issues = new[]{"Interpretation exceeds the bounded request size. The original needs review."} });
        var staged = queue.StageWorkspace(bytes, name, body, w.ActiveGrant!.InstallationId, obs, s);
        // Delivery indices bind their signed receipt by hash. Reading its pixels
        // or text adds no delivery claim and must not hold the dispatch feed.
        var indexedReceipt = s.Roles.Contains("delivery") && !s.Roles.Contains("evidence") &&
            parsed.Format=="pdf" && SourceReaders.QualifiedReceiptPdf(bytes);
        if (SourceReaders.IsMedia(name) && !indexedReceipt && !s.MediaJobs.Contains(staged.Id)) s.MediaJobs.Add(staged.Id);
        s.Inventory[key] = new(digest, sequence, s.Generation, name);
        WakeService();
        if (!awaitingSidecar && records.Length == 0) s.Issue = "PROFILE_NEEDS_REVIEW";
        if (records.Length > 0 && Optional(s.Recognition, "state")?.GetString() == "empty")
        {
            s.Recognition = Json.Element(new {state="recognized",message=$"Found {records.Length} record(s) in {name}.",
                fields=parsed.Headers.Take(16).Select(h=>string.Concat(h.Take(80))),fileName=name});
        }
        Save(); // Never checkpoint before durable staging. Replay reconstructs the same logical observation.
    }

    private async Task SubmitOneWorkspaceOriginal(OrderWorkspaceState w, WorkspaceSource source, CancellationToken ct)
    {
        var entry = queue.NextWorkspace(source,w.ActiveGrant!.InstallationId,DateTimeOffset.UtcNow);
        if (entry is null) return;
        var payload = queue.Payload(entry);
        var wire = payload.PreviewWireBody ?? throw new ConnectException("WORKSPACE_PAYLOAD_MISSING","The retained original is unavailable. Preserve the queue and contact support.");
        if (HashBytes(wire) != payload.PreviewBodySha256) throw new ConnectException("SPOOL_DIGEST_MISMATCH", "The captured request failed its integrity check.");
        var captured = Json.Read<JsonElement>(wire);
        var sendDigest = payload.PreviewBodySha256!;
        if (captured.GetProperty("scopeDigest").GetString() != w.ActiveGrant!.ScopeDigest)
        {
            if (source.Id != captured.GetProperty("sourceId").GetString() || source.Generation != captured.GetProperty("generation").GetInt32()
                || source.ProfileVersion != captured.GetProperty("profileVersion").GetString() || entry.CredentialGeneration != w.ActiveGrant.InstallationId)
            {
                queue.Save(entry,payload,"action_needed",error:"WORKSPACE_SCOPE_CHANGED"); source.Issue="WORKSPACE_SCOPE_CHANGED"; return;
            }
            // Another source or the destination changed. Authorize delivery of
            // the identical recorded action under the newly approved same source generation.
            var fields = captured.EnumerateObject().ToDictionary(p=>p.Name,p=>p.Value);
            fields["scopeDigest"] = Json.Element(w.ActiveGrant.ScopeDigest);
            wire=Json.Bytes(fields); sendDigest=HashBytes(wire);
        }
        try
        {
            var receipt = await api.Request("POST", WorkspaceApi + "/observations", new ExactJsonBody(wire, sendDigest),
                state.Token, entry.PreviewKey, ct);
            var status = receipt.GetProperty("state").GetString();
            if (status is not ("accepted" or "pending") || receipt.GetProperty("originalSha256").GetString() != entry.Digest
                || string.IsNullOrEmpty(receipt.GetProperty("receiptId").GetString()))
                throw new ConnectException("RECEIPT_MISMATCH","The server receipt does not identify the captured original. Preserve the queue and retry.");
            payload.Receipt = receipt;
            queue.Save(entry,payload,"complete",importId:receipt.GetProperty("receiptId").GetString());
            if (status == "pending" && captured.GetProperty("records").GetArrayLength() > 0) source.Issue = "IDENTITY_UNRESOLVED";
            if (receipt.TryGetProperty("proofs",out var changed) && changed.ValueKind == JsonValueKind.Array &&
                changed.EnumerateArray().Any(item => item.TryGetProperty("proofId",out var id) && item.TryGetProperty("revision",out var revision) &&
                    !workspaceOrders.Any(card => card.GetProperty("proofId").GetString()==id.GetString() && card.GetProperty("revision").GetInt32()>=revision.GetInt32())))
            {
                ordersCurrent = false;
                if (nextOrderRefresh > earliestReceiptRefresh) nextOrderRefresh = earliestReceiptRefresh;
            }
            WakeService();
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
