using System.Text.Json;

namespace PackProof.Connect;

public sealed partial class AgentRuntime
{
    private const string WorkspaceApi = "/v1/partner/agent/order-workspace";
    private DateTimeOffset nextWorkspacePoll;
    private DateTimeOffset nextOrderRefresh;
    private JsonElement[] workspaceOrders = [];
    private string? ordersScope;
    private bool ordersCurrent;
    private IEnumerable<string> WorkspaceSourceFolders => state.Workspace?.Sources.Where(s => s.Transport == "folder" && s.Roles.Count > 0).Select(s => s.Folder) ?? [];
    private bool CurrentInstallation => !checkpointed && state.Token is not null && ServerState is not ("revoked" or "paused")
        && state.CredentialRecoveryConfirmedAt is null && state.CredentialExpiresAt > DateTimeOffset.UtcNow
        && state.Transport?.State is not ("unauthenticated" or "forbidden");
    private bool WorkspaceGrantCurrent
    {
        get
        {
            var grant = state.Workspace?.ActiveGrant;
            if (grant is null || !CurrentInstallation || state.InstallationId != grant.InstallationId) return false;
            var elapsed = DateTimeOffset.UtcNow - grant.CheckedAt;
            var duration = networkOnline ? Math.Max(15, grant.OfflineWindowSeconds) : grant.OfflineWindowSeconds;
            return elapsed >= TimeSpan.Zero && elapsed <= TimeSpan.FromSeconds(duration);
        }
    }
    private bool WorkspaceAllowsProofOutput => WorkspaceGrantCurrent && networkOnline && ProofOutputFolder is { } folder
        && state.Workspace!.ActiveGrant!.OutputDigest == SourceFolderDigest(folder);

    private bool WorkspaceTookOver(string previousId) => state.Workspace?.Sources.Any(s => s.PreviousCollectorId == previousId && s.ReplacesPreviousCollector) == true;

    private void InitializeSourceState()
    {
        var previousVersion = state.StateVersion;
        SourceStateMigration.SynchronizeLegacy(state);
        // Only folders already present at upgrade are eligible for automatic migration.
        // A new CSV setup may preview a folder without registering a workspace source.
        var migrateFolders = !state.LegacyWorkspaceMigrationChecked && state.Workspace is null &&
            state.SourceSubscriptions.Any(s => s.Folder is not null);
        if (migrateFolders)
        {
            var migrated = Draft(includePreviousSetup: true);
            if (state.SourceSubscriptions.Any(s => s.Folder != null && s.ServerState == "active" && !s.LocalPaused))
                migrated.Step = "overview";
        }
        state.LegacyWorkspaceMigrationChecked = true;
        if (migrateFolders || previousVersion < SourceStateMigration.Version) Save();
    }

    private OrderWorkspaceState Draft(bool includePreviousSetup = false)
    {
        if (state.Workspace is { Version: not 1 }) throw new ConnectException("WORKSPACE_VERSION_UNSUPPORTED", "Install a compatible PackProof update to open this setup.");
        if (state.Workspace is not null) return state.Workspace;
        // An additive projection preserves all existing source and queue identities.
        // Its separate scope never turns a CSV permission into multi-format authority.
        if (store.Read<LocalState>("state.bin") is { } previous && store.Read<LocalState>("pre-workspace-state.bin") is null)
            store.Write("pre-workspace-state.bin", previous);
        var result = new OrderWorkspaceState();
        foreach (var prior in state.SourceSubscriptions.Where(s => s.Folder is not null &&
            (includePreviousSetup || s.CapabilityApproved || s.ApprovedConfiguration is not null || s.ServerState == "active")))
        {
            if (result.Sources.Any(s => string.Equals(s.Folder, prior.Folder, StringComparison.OrdinalIgnoreCase))) continue;
            var source = result.Assign(prior.Folder!, "shipping");
            source.Id = prior.Id;
            source.PreviousCollectorId = prior.Id;
            source.Recognition = Json.Element(new { state = "recognized", message = "Previously connected shipment source", fields = Array.Empty<string>() });
        }
        state.Workspace = result;
        return result;
    }

    private object WorkspaceView()
    {
        var w = state.Workspace;
        return new
        {
            step = w?.Step ?? "order", phase = w?.Phase ?? "draft",
            approvalPath = w?.ContinueAfterEnrollment == true && state.Token is null && state.EnrollmentState == "pending" ? state.ApprovalPath : w?.ApprovalPath, expiresAt = w?.ExpiresAt, attention = w?.Attention,
            outputFolder = ProofOutputFolder, outputState = ProofOutputState switch {
                "ready" or "pending" or "current" => "ready", "access_denied" => "denied", "unavailable" => "unavailable", _ => "unselected"
            },
            canReadOrders = WorkspaceGrantCurrent, viewKey = WorkspaceGrantCurrent ? w?.ActiveGrant?.ScopeDigest : null,
            orders = WorkspaceGrantCurrent && ordersScope == w?.ActiveGrant?.ScopeDigest ? workspaceOrders : [],
            syncState = WorkspaceGrantCurrent && networkOnline && ordersCurrent ? "current" : "pending",
            sources = (w?.Sources ?? []).Where(s => s.Roles.Count > 0).Select(s => new
            {
                s.Id, s.Folder, s.DisplayName, s.Transport, s.SourceNamespace, s.Roles, s.Generation, recognition = s.Recognition ?? Json.Element(new { state = "incomplete", message = "Check this folder to preview its records.", fields = Array.Empty<string>() }),
                state = s.Paused ? "paused" : s.Issue is not null ? "needs_attention"
                    : s.PreviousCollectorId is { } priorId && !s.ReplacesPreviousCollector ? state.SourceSubscriptions.FirstOrDefault(p => p.Id == priorId)?.ServerState ?? "needs_approval"
                    : WorkspaceGrantCurrent && w!.ActiveGrant!.Generations.GetValueOrDefault(s.Id) == s.Generation ? "active" : "pending",
                issue = s.Issue, coverageGap = s.CoverageGap, s.LastScanAt, pendingMedia = s.MediaJobs.Count, historyState = s.ApiHistoryState,
                queued = queue.Counts(DurableQueue.WorkspaceLane(s.Id)).Where(p => p.Key != "complete").Sum(p => p.Value)
            }).ToArray()
        };
    }
    private WorkspaceSource Source(OrderWorkspaceState w, JsonElement p) =>
        w.Sources.FirstOrDefault(s => s.Id == p.GetProperty("sourceId").GetString() && s.Roles.Count > 0)
            ?? throw new ConnectException("SOURCE_NOT_FOUND", "This folder changed. Open Sources and choose it again.");

    private async Task WorkspaceCommand(string operation, JsonElement p, CancellationToken ct)
    {
        if (ServerState == "revoked" || state.CredentialRecoveryConfirmedAt is not null || state.Token is not null && !CurrentInstallation)
            throw new ConnectException("AUTH_REQUIRED", "Reconnect this computer to its approved PackProof workspace.");
        var w = Draft();
        switch (operation)
        {
            case "saveWorkspaceStep":
                var step = p.GetProperty("step").GetString() ?? "";
                if (!OrderWorkspaceState.IsStep(step)) throw new ConnectException("STEP_INVALID", "Choose a setup step.");
                w.Step = step;
                break;
            case "addWorkspaceDirectSource":
                if (p.GetProperty("role").GetString() != "order") throw new ConnectException("SOURCE_ROLE_INVALID", "Partner API connections supply order records.");
                w.ConnectPartner(Optional(p,"sourceNamespace")?.GetString() ?? "partner-api");
                break;
            case "addWorkspaceSource":
            {
                var raw = p.GetProperty("folder").GetString() ?? "";
                ValidateProofSourceFolder(raw);
                var folder = FolderSource.ValidateWorkspaceRoot(raw);
                using var pin = new ProofOutputPaths.DirectoryPin(folder);
                var physical = pin.KeyStrings.FirstOrDefault();
                var equivalent = physical == null ? null : w.Sources.FirstOrDefault(s => s.PhysicalRoot == physical && s.Roles.Count > 0);
                var requestedRole = p.GetProperty("role").GetString() ?? "";
                var picked = w.Assign(equivalent?.Folder ?? folder, requestedRole);
                picked.InspectRole = requestedRole;
                if (picked.PhysicalRoot is { } oldRoot && oldRoot != physical)
                {
                    picked.Generation = checked(picked.Generation + 1);
                    picked.ConfirmedMap = null;
                    picked.ConfirmedWorkflow = null;
                    picked.Workflows.Clear();
                    w.Invalidate();
                }
                picked.PhysicalRoot = physical;
                if (picked.PreviousCollectorId is not null && picked.Roles.Count > 1)
                {
                    // Transition only after a new exact scope is approved. Existing queued
                    // work remains owned by its original grant throughout the cutover.
                    picked.Recognition = null;
                }
                InspectWorkspaceSource(picked);
                break;
            }
            case "chooseWorkspaceRelatedSource":
                var related = Source(w,p);
                var targetRole = p.GetProperty("role").GetString() ?? "";
                var targetId = p.GetProperty("relatedId").GetString();
                if (related.Generation != p.GetProperty("expectedGeneration").GetInt32() ||
                    !w.Sources.Any(s => s.Id == targetId && s.Id != related.Id && s.Roles.Contains(targetRole)))
                    throw new ConnectException("SOURCE_REFERENCE_CHANGED", "Check the related source again.");
                related.RelatedSources[targetRole] = targetId!;
                related.ProposedWorkflow = null;
                InspectWorkspaceSource(related);
                break;
            case "confirmWorkspaceOrderMap":
                var toMap = Source(w,p);
                var workflowProfile = toMap.ProposedWorkflow is null ? null : SourceReaders.WorkflowProfileVersion(toMap.ProposedWorkflow);
                var proposedProfile = workflowProfile ?? (toMap.ProposedMap == null ? null : SourceReaders.OrderProfileVersion(toMap.ProposedMap));
                if (toMap.Generation != p.GetProperty("expectedGeneration").GetInt32() || proposedProfile == null
                    || proposedProfile != p.GetProperty("profileVersion").GetString())
                    throw new ConnectException("PROFILE_CHANGED", "Check the folder again before confirming its order references.");
                if (toMap.ConfirmedWorkflow != null) { toMap.Workflows.Add(toMap.ConfirmedWorkflow); toMap.ConfirmedWorkflow = null; }
                if (toMap.ProposedWorkflow is { } workflow)
                {
                    toMap.Workflows.RemoveAll(m=>m.Role==workflow.Role);
                    toMap.Workflows.Add(workflow);
                }
                toMap.ProposedWorkflow = null;
                toMap.ConfirmedDependencies = toMap.RelatedSources.Values.Distinct().Where(id => w.Sources.Any(s=>s.Id==id && s.Roles.Count>0))
                    .ToDictionary(id=>id,id=>w.Sources.Single(s=>s.Id==id).Generation);
                if (toMap.ProposedMap != null) toMap.ConfirmedMap = toMap.ProposedMap;
                toMap.ProposedMap = null;
                toMap.Generation = checked(toMap.Generation + 1);
                w.Invalidate();
                InspectWorkspaceSource(toMap);
                break;
            case "inspectWorkspaceSource":
                var inspected = Source(w,p);
                if (inspected.Transport == "folder") InspectWorkspaceSource(inspected);
                break;
            case "removeWorkspaceRole":
                var changed = Source(w, p);
                var removingRole = p.GetProperty("role").GetString();
                if (changed.Transport == "api" && changed.Roles.Contains(removingRole ?? ""))
                    await SetWorkspacePaused(w,changed,true,ct);
                if (changed.Roles.Remove(p.GetProperty("role").GetString() ?? ""))
                {
                    changed.Generation = checked(changed.Generation + 1);
                    changed.Paused = changed.Roles.Count == 0;
                    changed.Recognition = null;
                    changed.Workflows.RemoveAll(m=>m.Role==removingRole);
                    if (changed.ConfirmedWorkflow?.Role==removingRole) changed.ConfirmedWorkflow=null;
                    if (removingRole=="order") changed.ConfirmedMap=null;
                    changed.InspectRole=changed.Roles.LastOrDefault();
                    w.Invalidate();
                    if (changed.Roles.Count > 0 && changed.Transport == "folder") InspectWorkspaceSource(changed);
                }
                break;
            case "setWorkspaceOutput":
                var previous = ProofOutputFolder;
                ConfigureProofOutput(p.GetProperty("folder").GetString() ?? "",
                    WorkspaceSourceFolders.Concat(state.SourceSubscriptions.Select(s => s.Folder).OfType<string>()));
                if (!string.Equals(previous, ProofOutputFolder, StringComparison.OrdinalIgnoreCase)) w.Invalidate();
                break;
            case "activateWorkspace":
                var pendingOutput = p.TryGetProperty("allowPendingOutput", out var allow) && allow.ValueKind == JsonValueKind.True;
                if (!w.Sources.Any(Eligible) || ProofOutputFolder is null)
                    throw new ConnectException("WORKSPACE_INCOMPLETE", "Choose at least one eligible source and a proof folder before starting.");
                if (state.Token is null)
                {
                    if (state.EnrollmentState != "pending" || state.EnrollmentExpiresAt <= DateTimeOffset.UtcNow) await BeginEnrollment(ct);
                    w.ContinueAfterEnrollment = true;
                    w.AllowPendingOutput = pendingOutput;
                    w.Step = "activate";
                    w.Attention = "Approve this computer in your browser. PackProof will then open the source review.";
                    break;
                }
                await ProposeWorkspace(w, pendingOutput, ct);
                break;
            case "pauseWorkspaceSource": await SetWorkspacePaused(w,Source(w,p),true,ct); break;
            case "resumeWorkspaceSource": await SetWorkspacePaused(w,Source(w,p),false,ct); break;
        }
    }

    private async Task SetWorkspacePaused(OrderWorkspaceState w, WorkspaceSource source, bool pause, CancellationToken ct)
    {
        if (source.Transport == "api" && w.ActiveGrant is { } grant && grant.Generations.GetValueOrDefault(source.Id) == source.Generation)
        {
            var reply = await api.Request("POST", WorkspaceApi + "/api-source-pause",new { sourceId=source.Id,generation=source.Generation,scopeDigest=grant.ScopeDigest,paused=pause },state.Token,null,ct);
            if (reply.GetProperty("paused").GetBoolean() != pause)
                throw new ConnectException("SOURCE_PAUSE_UNCONFIRMED", "PackProof did not confirm the new source state. Review the connection again.");
        }
        source.Paused = pause;
    }

    private static bool Eligible(WorkspaceSource source) => !source.Paused && source.Roles.Count > 0 &&
        Optional(source.Recognition, "state")?.GetString() is "empty" or "recognized";

    private async Task ProposeWorkspace(OrderWorkspaceState w, bool allowPendingOutput, CancellationToken ct)
    {
        RequireCredential();
        RequireReasonableClock(DateTimeOffset.UtcNow);
        if (Optional(Optional(state.ServerConfig,"capabilities"),"orderWorkspace")?.ValueKind == JsonValueKind.False)
            throw new ConnectException("WORKSPACE_NOT_AVAILABLE", "Multi-source collection is not enabled for this workspace. Your draft and existing connections are saved.");
        if (w.Phase == "awaiting_approval" && w.ExpiresAt > DateTimeOffset.UtcNow) { await PollWorkspace(w, ct); return; }
        if (ProofOutputFolder is not { } output || ProofOutputState is not ("ready" or "current" or "pending") && !(allowPendingOutput && ProofOutputState == "unavailable"))
            throw new ConnectException("OUTPUT_UNAVAILABLE", "Choose a proof folder the background service can write.");
        var sources = w.Sources.Where(Eligible).OrderBy(s => s.Id, StringComparer.Ordinal).ToArray();
        if (sources.Length == 0) throw new ConnectException("SOURCE_REQUIRED", "Choose a recognized source or an empty folder that will receive supported records.");
        var outputDigest = SourceFolderDigest(output);
        var proposal = new
        {
            sources = sources.Select(s => new { id = s.Id, generation = s.Generation, folderDigest = s.Transport == "api" ? Hash(JsonSerializer.Serialize(new { provider = "partner-api", account = Optional(state.ServerConfig,"integrationAccountId"), s.SourceNamespace })) : SourceFolderDigest(s.Folder),
                transport = s.Transport, sourceNamespace = s.SourceNamespace,
                roles = s.Roles.Order(StringComparer.Ordinal).ToArray(), profileVersion = s.ProfileVersion, displayName = s.Transport == "api" ? s.DisplayName + " (" + s.SourceNamespace + ")" : s.Folder }).ToArray(),
            outputDigest, outputName = output, history = OrderWorkspaceState.History
        };
        JsonElement result;
        try
        {
            result = await api.Request("POST", WorkspaceApi + "/proposals", proposal, state.Token, null, ct);
        }
        catch (ApiException error) when (error.Status == 404 || error.Code == "RECONSTRUCTION_CAPABILITY_DISABLED")
        {
            throw new ConnectException("WORKSPACE_NOT_AVAILABLE", "This PackProof workspace is not ready for multi-source collection yet. Your setup is saved. Retry after your workspace is enabled.");
        }
        var digest = result.GetProperty("scopeDigest").GetString();
        if (digest?.Length != 64 || !digest.All(Uri.IsHexDigit))
            throw new ConnectException("WORKSPACE_APPROVAL_INVALID", "PackProof returned an incomplete approval. Retry setup.");
        w.InstallationId = state.InstallationId;
        w.SubmittedGenerations = sources.ToDictionary(s => s.Id, s => s.Generation);
        w.ApprovedOutputDigest = outputDigest;
        w.ScopeDigest = digest;
        w.Phase = "awaiting_approval";
        w.Step = "activate";
        ApplyWorkspaceResponse(w, result);
        Save();
    }

    private void ApplyWorkspaceResponse(OrderWorkspaceState w, JsonElement response)
    {
        var remoteState = response.GetProperty("state").GetString();
        if (Optional(response, "scopeDigest")?.GetString() != w.ScopeDigest || w.InstallationId != state.InstallationId
            || remoteState is not ("pending" or "active"))
        {
            // A different committed or revoked scope invalidates cached read/write authority.
            if (remoteState != "expired" && remoteState != "denied") w.ActiveGrant = null;
            w.Invalidate();
            w.Attention = remoteState == "expired" ? "Browser approval expired. Start collecting again to request a new approval." :
                "The approved sources changed. Review the current folders and start collection again.";
            return;
        }
        w.ExpiresAt = Optional(response, "expiresAt") is { ValueKind: JsonValueKind.String } exp ? exp.GetDateTimeOffset() : null;
        w.CheckedAt = DateTimeOffset.UtcNow;
        w.OfflineWindowSeconds = Optional(response, "offlineWindowSeconds") is { ValueKind: JsonValueKind.Number } window
            ? Math.Clamp(window.GetInt32(), 0, 3600) : 0;
        var becomesActive = w.Phase != "active";
        w.Phase = remoteState == "active" ? "active" : "awaiting_approval";
        w.ApprovalPath = remoteState == "pending" ? Optional(response, "approvalPath")?.GetString() : null;
        w.Attention = null;
        if (remoteState == "active")
        {
            w.ActiveGrant = new(w.InstallationId!, w.ScopeDigest!, w.ApprovedOutputDigest!,
                new(w.SubmittedGenerations), w.CheckedAt.Value, w.OfflineWindowSeconds);
            foreach (var source in w.Sources.Where(s => s.PreviousCollectorId != null && w.SubmittedGenerations.GetValueOrDefault(s.Id) == s.Generation))
                source.ReplacesPreviousCollector = true;
            if (becomesActive) { w.Step = "overview"; ordersCurrent = false; nextOrderRefresh = DateTimeOffset.MinValue; }
        }
    }

    private async Task PollWorkspace(OrderWorkspaceState w, CancellationToken ct)
    {
        var result = await api.Request("GET", WorkspaceApi, null, state.Token, null, ct);
        ApplyWorkspaceResponse(w, result);
        Save();
    }

    private object WorkspaceDirectConnection(JsonElement p)
    {
        var w = state.Workspace;
        if (!WorkspaceGrantCurrent || w?.ActiveGrant is not { } grant)
            throw new ConnectException("AUTH_REQUIRED", "Approve the API order source before copying its connection settings.");
        var source = Source(w,p);
        if (source.Transport != "api" || source.Paused || grant.Generations.GetValueOrDefault(source.Id) != source.Generation)
            throw new ConnectException("SOURCE_SCOPE_CHANGED", "Review this API source and its current access.");
        return new { name = source.DisplayName, endpoint = host.ApiOrigin.TrimEnd('/') + "/v1/partner/proofs", method = "POST",
            sourceNamespace = source.SourceNamespace, integrationAccountId = Optional(state.ServerConfig,"integrationAccountId"),
            operatorMembershipId = Optional(state.ServerConfig,"operatorMembershipId"),
            connectOperation = new { installationId = grant.InstallationId, scopeDigest = grant.ScopeDigest, sourceId=source.Id, generation=source.Generation } };
    }

    private async Task<object> WorkspaceOrderDetail(JsonElement p, CancellationToken ct)
    {
        if (!WorkspaceGrantCurrent) throw new ConnectException("AUTH_REQUIRED", "Reconnect this workspace to open the latest order.");
        var id = p.GetProperty("proofId").GetString();
        var revision = p.GetProperty("revision").GetInt32();
        if (id is not { Length: > 0 and <= 120 } || id.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '-' && c != '_') || revision < 1)
            throw new ConnectException("ORDER_INVALID", "Choose an order from the current list.");
        return OrderForDesktop(await api.Request("GET", $"/v1/partner/agent/order-proofs/{id}/revisions/{revision}", null, state.Token, null, ct));
    }
}

