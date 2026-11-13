using System.Diagnostics;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
namespace PackProof.Connect;

public sealed class AgentRuntime : IDisposable
{
    private readonly HostConfiguration host; private readonly ProtectedStore store; private readonly DurableQueue queue = null!; private readonly PackProofClient api; private LocalState state; private readonly SemaphoreSlim gate = new(1, 1);
    private ConnectException? startupError;
    private bool networkOnline = true; private bool checkpointed; private JsonElement? localPreview; private DateTimeOffset lastRefresh = DateTimeOffset.MinValue; private DateTimeOffset lastScan = DateTimeOffset.MinValue; private DateTimeOffset lastCleanup = DateTimeOffset.MinValue;
    public AgentRuntime(HostConfiguration configuration)
    {
        host = configuration; host.Validate(); if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("The installed collector requires Windows."); if (!WindowsIdentity.GetCurrent().User!.IsWellKnown(WellKnownSidType.LocalServiceSid)) throw new ConnectException("SERVICE_IDENTITY_INVALID", "The collector must run as its installed LocalService identity."); store = new(host.DataRoot, new ServiceIdentityProtector()); state = new(); api = new(host);
        try{
            var serviceSid = (SecurityIdentifier)new NTAccount($"NT SERVICE\\{host.ServiceName}").Translate(typeof(SecurityIdentifier));
            if (WindowsIdentity.GetCurrent().Groups?.Contains(serviceSid) != true) throw new ConnectException("SERVICE_IDENTITY_INVALID", "The collector must receive its dedicated service SID. Ask IT to repair the installed service identity before accessing protected work.");
            ProtectedAncestry.Assert(host.DataRoot, Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), serviceSid.Value);
            store.Initialize();state=store.Read<LocalState>("state.bin")??new();queue=new(store);
        }
        catch(ConnectException error){startupError=error;state=new(){LastErrorCode=error.Code};}
        catch(Microsoft.Data.Sqlite.SqliteException){startupError=new("LOCAL_QUEUE_UNAVAILABLE","The retained queue cannot be opened safely. Preserve its database, journal and protected keys and contact support; the service will not replace it with an empty queue.");state=new(){LastErrorCode=startupError.Code};}
        catch(Exception error)when(error is IOException or UnauthorizedAccessException){startupError=new("LOCAL_STORAGE_UNAVAILABLE","The service cannot safely access its local protected storage. Ask IT to repair permissions or disk space; queued work is preserved.");state=new(){LastErrorCode=startupError.Code};}
    }
    // Internal transport seam exercises crash/retry orchestration without simulating Windows service identity checks.
    internal AgentRuntime(HostConfiguration configuration, ProtectedStore storage, PackProofClient transport, LocalState initialState) { host = configuration; host.Validate(); store = storage; state = initialState; queue = new(store); api = transport; }
    private void Save() => store.Write("state.bin", state);
    private static string Hash(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    private string Generation => state.Token is null ? "none" : Hash(state.Token);
    private JsonElement? Approved => state.ServerConfig?.TryGetProperty("config", out var config) == true && config.ValueKind == JsonValueKind.Object ? config : null;
    private string ServerState => state.ServerConfig?.TryGetProperty("state", out var status) == true ? status.GetString() ?? "needs_approval" : "needs_approval";
    private string ConfigDigest => state.ServerConfig?.TryGetProperty("configSha256", out var d) == true ? d.GetString() ?? "none" : "none";
    private string QueueConfigIdentity => Hash($"{state.InstallationId ?? "unenrolled"}:{ConfigDigest}:{ConfigRevision}");
    private IReadOnlyList<QueueEntry> CurrentEntries() => queue.Entries().Where(x => x.CredentialGeneration == Generation && x.ConfigDigest == QueueConfigIdentity).ToArray();
    private bool RecoveryAvailable => state.Token is not null && (ServerState == "revoked" || state.CredentialExpiresAt <= DateTimeOffset.UtcNow || (state.CredentialRecoveryConfirmedAt is not null && DateTimeOffset.UtcNow - state.CredentialRecoveryConfirmedAt.Value is var elapsed && elapsed >= TimeSpan.Zero && elapsed <= TimeSpan.FromMinutes(5)));
    private int ConfigRevision => state.ServerConfig?.TryGetProperty("configRevision", out var r) == true ? r.GetInt32() : 0;
    private bool ConfigMatches => Approved?.GetProperty("folderDigest").GetString() == state.FolderDigest;
    private void RequireCredential() { if (state.Token is null) throw new ConnectException("ENROLLMENT_REQUIRED", "Approve this collection computer in PackProof first."); }
    private void RequireConfig() { RequireCredential(); if (!ConfigMatches) throw new ConnectException("CONFIGURATION_APPROVAL_REQUIRED", "Approve the exact export source and mapping in your PackProof browser before uploading."); }
    private bool MayCollect(DateTimeOffset now)
    {
        if (checkpointed || state.LocalPaused || ServerState != "active" || !ConfigMatches || state.LastPolicyCheckAt is null) return false;
        var hours = Approved?.GetProperty("offlineWindowHours").GetDouble() ?? 24;
        if (!CollectionPolicy.IsWithinApprovedWindow(now, state.LastPolicyCheckAt, state.CredentialExpiresAt, hours, networkOnline)) { state.LastErrorCode = "POLICY_REFRESH_REQUIRED"; return false; }
        return true;
    }
    private static JsonElement? Optional(JsonElement? document,string property)=>document?.TryGetProperty(property,out var value)==true?value:null;
    private string? ReviewPath(JsonElement? preview)
    {
        if (ServerState == "revoked") return null;
        if (state.Token is null)
            return state.EnrollmentState == "pending" && state.EnrollmentExpiresAt > DateTimeOffset.UtcNow ? state.ApprovalPath : null;
        if (state.InstallationId is null) return null;
        var path = $"/app/records/connect/approve?installationId={Uri.EscapeDataString(state.InstallationId)}";
        if (preview?.TryGetProperty("id", out var importId) == true && importId.ValueKind == JsonValueKind.String)
            return path + "&importId=" + Uri.EscapeDataString(importId.GetString()!);
        var proposal = Optional(state.ServerConfig, "pendingProposal");
        if (proposal?.ValueKind == JsonValueKind.Object) return path;
        if (Approved is null) return null;
        return state.ApprovalPath == path + "&action=resume" ? path + "&action=resume" : path;
    }
    private object Status()
    {
        if(startupError is not null)return new{state="action_needed",environment=host.Environment,installedVersion="0.1.0",health=new{serviceOnline=true,queueCount=(int?)null,lastErrorCode=startupError.Code},error=new{code=startupError.Code,message=startupError.Message}};
        object? source = null; if (state.Folder is not null) { try { source = new { folder = state.Folder, folderDigest = state.FolderDigest, accessible = true, files = FolderSource.Inventory(state.Folder).Take(20).ToArray(), selectedFileName = state.FileName, headers = localPreview?.GetProperty("headers"), samples = localPreview?.GetProperty("samples"), fileSha256 = state.FileDigest, rowCount = localPreview?.GetProperty("rowCount") }; } catch (Exception e) when (e is ConnectException or IOException or UnauthorizedAccessException) { source = new { folder = state.Folder, folderDigest = state.FolderDigest, accessible = false, errorCode = e is ConnectException c ? c.Code : "SOURCE_ACCESS_DENIED" }; } }
        JsonElement? preview = null; if (state.SetupQueueId is not null) { var entry = queue.Find(state.SetupQueueId); if (entry is not null) preview = queue.Payload(entry).Receipt; }
        var reviewPath = ReviewPath(preview);
        var verified = state.VerifiedRecordId is not null && ConfigMatches;
        var currentCollectionPolicy = CollectionPolicy.IsWithinApprovedWindow(DateTimeOffset.UtcNow, state.LastPolicyCheckAt, state.CredentialExpiresAt, Approved?.GetProperty("offlineWindowHours").GetDouble() ?? 24, networkOnline);
        var display = ServerState == "active" && !state.LocalPaused && !currentCollectionPolicy ? "action_needed" : ServerState == "revoked" ? "revoked" : (ServerState == "paused" || (ServerState == "active" && state.LocalPaused)) ? "paused" : state.Token is null ? "needs_approval" : state.Folder is null ? "source_selected" : !ConfigMatches ? "needs_approval" : verified ? ServerState == "active" && !state.LocalPaused ? "active" : "ready_to_activate" : preview is null ? "source_selected" : preview.Value.GetProperty("state").GetString() == "previewed" ? "preview_ready" : "verification_pending";
        return new { state = display, installationId = state.InstallationId, environment = host.Environment, configRevision = ConfigRevision, source, enrollment = state.EnrollmentId is null ? null : new { id = state.EnrollmentId, comparisonCode = state.ComparisonCode, expiresAt = state.EnrollmentExpiresAt, approvalPath = state.Token is null ? reviewPath : null, state = state.EnrollmentState }, installedVersion = "0.1.0", recoveryAvailable = RecoveryAvailable, pendingProposal = Optional(state.ServerConfig,"pendingProposal"), config = Approved, binding = state.ServerConfig is null ? null : new { integrationAccountId = state.ServerConfig.Value.GetProperty("integrationAccountId"), operatorMembershipId = state.ServerConfig.Value.GetProperty("operatorMembershipId"), sourceName = state.ServerConfig.Value.GetProperty("sourceName"), locationId = Optional(state.ServerConfig,"locationId") }, preview = preview is null ? null : PreviewView(preview.Value), verification = new { complete = verified, recordId = verified ? state.VerifiedRecordId : null, recordUrl = verified ? $"{host.WebOrigin.TrimEnd('/')}/app/records/{Uri.EscapeDataString(state.VerifiedRecordId!)}" : null, configRevision = ConfigRevision, fileSha256 = state.FileDigest }, health = new { serviceOnline = true, lastScanAt = state.LastScanAt, lastExportAt = state.LastExportAt, lastCompletedImportAt = state.LastCompletedImportAt, lastReceiptReconciledAt = state.LastReceiptReconciledAt, quarantinedFileCount = CurrentEntries().Count(x => x.State is "action_needed" or "partial"), queueCount = CurrentEntries().Count(x => x.State != "complete"), preservedQueueCount = queue.Entries().Count(x => x.State != "complete") - CurrentEntries().Count(x => x.State != "complete"), orphanedPayloadCount = queue.OrphanCount, lastErrorCode = state.LastErrorCode, sourceFreshness = Optional(Optional(state.ServerConfig,"health"),"sourceFreshness"), sourceWatermarkAt = Optional(Optional(state.ServerConfig,"health"),"sourceWatermarkAt"), expectedIntervalSeconds = Optional(Optional(state.ServerConfig,"health"),"expectedIntervalSeconds"), sourceAccounting = Optional(Optional(state.ServerConfig,"health"),"sourceAccounting") }, approvalPath = reviewPath };
    }
    private static object PreviewView(JsonElement receipt)
    {
        static object? Cell(JsonElement v) => v.ValueKind == JsonValueKind.String ? (v.GetString()!.Length > 40 ? v.GetString()![..40] + "…" : v.GetString()) : v.ValueKind == JsonValueKind.Null ? null : v;
        var rows = receipt.GetProperty("rows").EnumerateArray().Take(10).Select(row => (object)new { rowNumber = row.GetProperty("rowNumber"), status = row.GetProperty("status"), errors = row.GetProperty("errors").EnumerateArray().Take(10).Select(x => x.GetString()).ToArray(), values = row.GetProperty("values").EnumerateObject().ToDictionary(x => x.Name, x => Cell(x.Value)), normalized = row.GetProperty("normalized") }).ToList();
        var records = receipt.GetProperty("recordIds").EnumerateArray().Take(20).ToArray();
        while (rows.Count > 0 && Json.Bytes(rows).Length > 65536) rows.RemoveAt(rows.Count - 1);
        return new { id = receipt.GetProperty("id"), previewVersion = receipt.GetProperty("previewVersion").GetString(), state = receipt.GetProperty("state"), original = receipt.GetProperty("original"), counts = receipt.GetProperty("counts"), rows, recordIds = records, displayRowsTruncated = receipt.GetProperty("rows").GetArrayLength() > rows.Count };
    }
    public async Task<object?> Command(string command, JsonElement? payload, CancellationToken ct)
    {
        await gate.WaitAsync(ct); try
        {
            if(startupError is not null&&command is not("status" or "preflight" or "diagnostics"))throw startupError;
            if(startupError is not null&&command=="diagnostics")return new{schema="packproof.connect-diagnostics/v1",version="0.1.0",environment=host.Environment,serviceOnline=true,lastErrorCode=startupError.Code};
            var p = payload ?? Json.Element(new { });
            switch (command)
            {
                case "status": return Status();
                case "preflight": return await Preflight(ct);
                case "beginEnrollment": await BeginEnrollment(ct); break;
                case "recoverEnrollment":
                    {
                        if (!p.TryGetProperty("preservePendingWorkApproved", out var consent) || consent.ValueKind != JsonValueKind.True || p.EnumerateObject().Any(x => x.Name != "preservePendingWorkApproved")) throw new ConnectException("RECOVERY_CONSENT_REQUIRED", "Confirm that former originals and receipt ownership remain preserved before starting fresh browser approval.");
                        if (!RecoveryAvailable) throw new ConnectException("RECOVERY_NOT_AVAILABLE", "This installation still has current authority. Pause or revoke it in PackProof before replacing its approval.");
                        state.LocalPaused = true; Save();
                        // A durable protected archive must exist before any credential,
                        // source binding or receipt reference is cleared from current state.
                        store.Write($"recovery-{Guid.NewGuid():N}.bin", new { schema = "packproof.connect-recovery/v1", archivedAt = DateTimeOffset.UtcNow, previousState = state, preservedQueue = queue.Entries() });
                        state = new LocalState { RecoveryPrepared = true, LocalPaused = true };
                        Save(); checkpointed = false; networkOnline = false; lastRefresh = DateTimeOffset.MinValue; localPreview = null;
                        break;
                    }
                case "pollEnrollment": await PollEnrollment(ct); break;
                case "selectFolder":
                    {
                        var folder = FolderSource.Validate(p.GetProperty("folder").GetString() ?? ""); if (folder != state.Folder) { state.Folder = folder; state.FolderDigest = Hash(folder.ToUpperInvariant()); state.FileName = null; state.FileDigest = null; state.ScanCursorFileName = null; state.SetupQueueId = null; state.VerifiedRecordId = null; state.LocalPaused = true; localPreview = null; }
                        break;
                    }
                case "localPreview":
                    {
                        if (state.Folder is null) throw new ConnectException("SOURCE_REQUIRED", "Choose the export folder first."); var name = p.GetProperty("fileName").GetString() ?? ""; var bytes = FolderSource.Snapshot(state.Folder, name); localPreview = Json.Element(FolderSource.Preview(bytes)); state.FileName = name; state.FileDigest = Convert.ToHexStringLower(SHA256.HashData(bytes)); state.SetupQueueId = null; state.VerifiedRecordId = null; break;
                    }
                case "proposeConfiguration":
                    {
                        RequireCredential(); RequireReasonableClock(DateTimeOffset.UtcNow); if (state.FolderDigest is null) throw new ConnectException("SOURCE_REQUIRED", "Choose an approved local export folder first."); var map = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(p.GetRawText())!; map["folderDigest"] = Json.Element(state.FolderDigest); state.LocalPaused = true; state.VerifiedRecordId = null; state.SetupQueueId = null; Save(); var result = await api.Request("POST", "/v1/partner/agent/config-proposals", map, state.Token, Guid.NewGuid().ToString("N"), ct); state.ApprovalPath = result.GetProperty("approvalPath").GetString(); state.LocalPaused = true; state.VerifiedRecordId = null; state.SetupQueueId = null; Save(); await Refresh(ct); break;
                    }
                case "preview":
                    {
                        RequireConfig(); if (!p.TryGetProperty("wholeFileUploadApproved", out var consent) || !consent.GetBoolean()) throw new ConnectException("UPLOAD_CONSENT_REQUIRED", "Confirm that the entire original CSV, including unmapped columns, will be uploaded and preserved."); if (state.FileName is null || state.Folder is null) throw new ConnectException("SOURCE_FILE_REQUIRED", "Select the exact CSV export first."); var bytes = FolderSource.Snapshot(state.Folder, state.FileName); if (Convert.ToHexStringLower(SHA256.HashData(bytes)) != state.FileDigest) throw new ConnectException("SOURCE_CHANGED", "The selected file changed. Read its local preview and approve it again."); _ = FolderSource.Preview(bytes); FolderSource.ValidateContract(bytes,Approved!.Value); var entry = queue.Stage(bytes, state.FileName, new(Approved!.Value), Generation, QueueConfigIdentity, false); state.SetupQueueId = entry.Id; Save(); await Process(entry, ct); var previewEntry = queue.Find(entry.Id)!; if (previewEntry.ImportId is not null) state.ApprovalPath = $"/app/records/connect/approve?installationId={Uri.EscapeDataString(state.InstallationId!)}&importId={Uri.EscapeDataString(previewEntry.ImportId)}"; break;
                    }
                case "commit":
                    {
                        RequireConfig(); if (!p.TryGetProperty("wholeBatchApproved", out var consent) || !consent.GetBoolean()) throw new ConnectException("BATCH_CONSENT_REQUIRED", "Approve importing every displayed row in this source batch."); var entry = SetupEntry(); if (entry.ConfigDigest != QueueConfigIdentity) throw new ConnectException("PREVIEW_CHANGED", "The configuration changed. Create a fresh preview."); var data = queue.Payload(entry); if (data.Receipt is null) throw new ConnectException("PREVIEW_REQUIRED", "Create the secure server preview first."); var counts = data.Receipt.Value.GetProperty("counts"); if (counts.GetProperty("invalid").GetInt32() > 0 || counts.GetProperty("ambiguous").GetInt32() > 0) throw new ConnectException("SETUP_ROWS_INVALID", "Correct all setup batch rows before verification."); data.CommitApproved = true; queue.Save(entry, data, "commit_pending"); await Process(queue.Find(entry.Id)!, ct); break;
                    }
                case "verify": { RequireConfig(); await Process(SetupEntry(), ct); await Verify(ct); break; }
                case "proposeActivation": { RequireConfig(); await Verify(ct); if (state.VerifiedRecordId is null) throw new ConnectException("VERIFICATION_REQUIRED", "Wait for the completed import and visible record before activation."); state.ApprovalPath = $"/app/records/connect/approve?installationId={Uri.EscapeDataString(state.InstallationId!)}"; break; }
                case "activate": case "resume": await Refresh(ct); if (ServerState != "active") throw new ConnectException("ACTIVATION_APPROVAL_REQUIRED", "Approve automatic collection in your PackProof browser first."); if (state.PauseAuthorizationTimestamp is not null && (!state.ServerConfig!.Value.TryGetProperty("authorizationUpdatedAt", out var updated) || string.CompareOrdinal(updated.GetString(), state.PauseAuthorizationTimestamp) <= 0)) throw new ConnectException("RESUME_APPROVAL_REQUIRED", "Approve resuming this exact connection in the PackProof browser first."); state.LocalPaused = false; state.PauseAuthorizationTimestamp = null; break;
                case "pause": state.LocalPaused = true; state.PauseAuthorizationTimestamp = state.ServerConfig?.TryGetProperty("authorizationUpdatedAt", out var at) == true ? at.GetString() : DateTimeOffset.UtcNow.ToString("O"); state.ApprovalPath = $"/app/records/connect/approve?installationId={Uri.EscapeDataString(state.InstallationId!)}&action=resume"; break;
                case "refresh": if (state.Token is not null) await Refresh(ct); else await PollEnrollment(ct); break;
                case "checkpoint": checkpointed = true; Save(); queue.Checkpoint(); return new { checkpointed = true, queuePreserved = true };
                case "diagnostics": return new { schema = "packproof.connect-diagnostics/v1", version = "0.1.0", environment = host.Environment, installationId = state.InstallationId, configRevision = ConfigRevision, createdAt = DateTimeOffset.UtcNow, serviceOnline = true, orphanedPayloadCount = queue.OrphanCount, preservedQueueCount = queue.Entries().Count(x => x.State != "complete") - CurrentEntries().Count(x => x.State != "complete"), receiptIds = queue.Entries().Where(x => x.ImportId is not null).Select(x => x.ImportId).Distinct().Take(20).ToArray(), queue = queue.Entries().GroupBy(x => x.State).ToDictionary(x => x.Key, x => x.Count()), lastScanAt = state.LastScanAt, lastExportAt = state.LastExportAt, lastCompletedImportAt = state.LastCompletedImportAt, lastReceiptReconciledAt = state.LastReceiptReconciledAt, lastErrorCode = state.LastErrorCode };
                default: throw new ConnectException("LOCAL_OPERATION_UNSUPPORTED", "This local operation is not supported.");
            }
            Save(); return Status();
        }
        finally { gate.Release(); }
    }
    private QueueEntry SetupEntry() => state.SetupQueueId is not null ? queue.Find(state.SetupQueueId) ?? throw new ConnectException("PREVIEW_REQUIRED", "Create a secure preview first.") : throw new ConnectException("PREVIEW_REQUIRED", "Create a secure preview first.");
    private static bool IsSupportedWindowsClient() => OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000)
        && System.Runtime.InteropServices.RuntimeInformation.OSArchitecture == System.Runtime.InteropServices.Architecture.X64
        && string.Equals(Microsoft.Win32.Registry.GetValue(@"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\ProductOptions", "ProductType", null) as string, "WinNT", StringComparison.Ordinal);
    private void RequireReasonableClock(DateTimeOffset now)
    {
        if (state.LastPolicyCheckAt > now || (api.LastServerDate is not null && Math.Abs((now - api.LastServerDate.Value).TotalMinutes) > 5))
        {
            state.LocalPaused = true; state.LastErrorCode = "CLOCK_UNCERTAIN"; Save();
            throw new ConnectException("CLOCK_UNCERTAIN", "The collection computer clock changed or differs from PackProof. Correct Windows time, then refresh and approve resuming collection.");
        }
    }
    private async Task<object> Preflight(CancellationToken ct)
    {
        var checks = new List<object> { new { id = "windows", label = "Windows 11 x64", state = IsSupportedWindowsClient() ? "passed" : "blocked", detail = "Windows 11 x64 is required for this connector." }, new { id = "identity", label = "Collection service identity", state = OperatingSystem.IsWindows() && WindowsIdentity.GetCurrent().User?.IsWellKnown(WellKnownSidType.LocalServiceSid) == true ? "passed" : "blocked", detail = "Collection runs as LocalService." }, new { id = "storage", label = "Protected service storage", state = startupError is null?"passed":"blocked", detail = startupError?.Message??"The running service encrypted and recovered a protected test value." }, new { id = "disk", label = "Disk reserve", state = new DriveInfo(Path.GetPathRoot(host.DataRoot)!).AvailableFreeSpace > DurableQueue.DiskReserveBytes ? "passed" : "blocked", detail = "At least 1 GiB of free reserve is required." } };
        try { await api.Request("GET", "/health", null, null, null, ct); checks.Add(new { id = "network", label = "HTTPS and service proxy access", state = "passed", detail = "The service reached the configured PackProof endpoint using Windows TLS trust." }); } catch (Exception e) when (e is ApiException or HttpRequestException or TaskCanceledException) { checks.Add(new { id = "network", label = "HTTPS and service proxy access", state = "blocked", detail = "The service could not verify the PackProof endpoint. Ask IT to check outbound HTTPS and service proxy access." }); }
        checks.Add(new { id = "clock", label = "Clock reasonableness", state = !api.LastResponseHadServerDate || api.LastServerDate is null ? "not_checked" : Math.Abs((DateTimeOffset.UtcNow - api.LastServerDate.Value).TotalMinutes) <= 5 ? "passed" : "blocked", detail = "Windows time must remain within five minutes of the PackProof server clock." }); return new { checks };
    }
    private async Task BeginEnrollment(CancellationToken ct)
    {
        if (!state.RecoveryPrepared && queue.Entries().Any(x => x.State != "complete")) throw new ConnectException("QUEUE_RECONCILIATION_REQUIRED", "Resolve or explicitly preserve the existing installation queue before replacing enrollment.");
        if (state.Token is not null) throw new ConnectException("INSTALLATION_ALREADY_ENROLLED", "This service is already enrolled. Use its PackProof portal to replace or revoke it.");
        var result = await api.Request("POST", "/connect/enrollments", new { deviceName = Environment.MachineName, version = "0.1.0" }, null, null, ct); state.EnrollmentId = result.GetProperty("id").GetString(); state.RedeemSecret = result.GetProperty("redeemSecret").GetString(); state.ComparisonCode = result.GetProperty("comparisonCode").GetString(); state.ApprovalPath = result.GetProperty("approvalPath").GetString(); state.EnrollmentExpiresAt = result.GetProperty("expiresAt").GetDateTimeOffset(); state.EnrollmentState = "pending"; state.LastEnrollmentPollAt = null; Save();
    }
    private async Task PollEnrollment(CancellationToken ct)
    {
        if (state.Token is not null) { await Refresh(ct); return; }
        if (state.EnrollmentState != "pending" || state.EnrollmentId is null || state.RedeemSecret is null) return;
        if (state.LastEnrollmentPollAt is not null && DateTimeOffset.UtcNow - state.LastEnrollmentPollAt < TimeSpan.FromSeconds(5)) return;
        if (state.EnrollmentExpiresAt < DateTimeOffset.UtcNow) { state.EnrollmentState = "expired"; state.RedeemSecret = null; Save(); return; }
        state.LastEnrollmentPollAt = DateTimeOffset.UtcNow; Save(); var r = await api.Request("POST", $"/connect/enrollments/{Uri.EscapeDataString(state.EnrollmentId)}/redeem", new { redeemSecret = state.RedeemSecret }, null, null, ct); state.EnrollmentState = r.GetProperty("state").GetString();
        if (state.EnrollmentState == "credential") { var env = r.GetProperty("environment").GetString(); if (env != (host.Environment == "live" ? "live" : "sandbox")) throw new ConnectException("ENVIRONMENT_MISMATCH", "The approved workspace does not match this installed environment."); state.Token = r.GetProperty("token").GetString(); state.InstallationId = r.GetProperty("installationId").GetString(); state.CredentialExpiresAt = r.GetProperty("expiresAt").GetDateTimeOffset(); try { Save(); } catch { state.Token = null; state.InstallationId = null; state.LocalPaused = true; checkpointed = true; throw; } await Refresh(ct); state.RedeemSecret = null; Save(); }
        else if (state.EnrollmentState is "denied" or "expired") state.RedeemSecret = null;
    }
    private async Task Refresh(CancellationToken ct)
    {
        RequireCredential(); RequireReasonableClock(DateTimeOffset.UtcNow); var before = ConfigDigest; var beforeRevision = ConfigRevision; JsonElement result; try { result = await api.Request("POST", "/v1/partner/agent/heartbeat", new { version = "0.1.0", enrollmentAcknowledged = true, queueCount = CurrentEntries().Count(x => x.State != "complete"), lastScanAt = state.LastScanAt, lastExportAt = state.LastExportAt, lastReceiptReconciledAt = state.LastReceiptReconciledAt, lastErrorCode = state.LastErrorCode }, state.Token, null, ct); } catch (ApiException denied) when (denied.Status is 401 or 403) { state.CredentialRecoveryConfirmedAt = DateTimeOffset.UtcNow; state.LastErrorCode = denied.Code; state.LocalPaused = true; Save(); throw; } state.CredentialRecoveryConfirmedAt = null; RequireReasonableClock(DateTimeOffset.UtcNow);
        // Clear only the resolved clock warning after a fresh, successful server
        // observation. Do not clear other errors, erase a pause or resume collection.
        if (state.LastErrorCode == "CLOCK_UNCERTAIN" && api.LastResponseHadServerDate) state.LastErrorCode = null;
        state.ServerConfig = result; if (result.TryGetProperty("credentialExpiresAt", out var expires) && expires.ValueKind == JsonValueKind.String) state.CredentialExpiresAt = expires.GetDateTimeOffset(); state.LastPolicyCheckAt = DateTimeOffset.UtcNow; lastRefresh = DateTimeOffset.UtcNow; networkOnline = true; if (state.EnrollmentState == "credential") state.RedeemSecret = null;
        if (before != "none" && (before != ConfigDigest || beforeRevision != ConfigRevision)) { state.SetupQueueId = null; state.VerifiedRecordId = null; state.LocalPaused = true; }
        if (ServerState == "revoked") state.LocalPaused = true; Save();
    }
    private async Task Process(QueueEntry entry, CancellationToken ct)
    {
        RequireConfig(); if (entry.CredentialGeneration != Generation) throw new ConnectException("CREDENTIAL_RECOVERY_REQUIRED", "This queued receipt belongs to an earlier credential. Use approved recovery; it cannot be transferred silently."); if (entry.ConfigDigest != QueueConfigIdentity) throw new ConnectException("CONFIGURATION_RECOVERY_REQUIRED", "This queued original belongs to an earlier approved configuration. Preserve it for explicit recovery.");
        var payload = queue.Payload(entry); try
        {
            JsonElement receipt;
            if (entry.ImportId is null) { queue.Save(entry, payload, "preview_pending"); entry = queue.Find(entry.Id)!; receipt = await api.Request("POST", "/v1/partner/imports/preview", payload.PreviewWireBody is null ? payload.PreviewBody : new ExactJsonBody(payload.PreviewWireBody, payload.PreviewBodySha256!), state.Token, entry.PreviewKey, ct); if (receipt.TryGetProperty("value", out var wrapped)) receipt = wrapped; if (receipt.GetProperty("original").GetProperty("sha256").GetString() != entry.Digest) throw new ConnectException("ORIGINAL_DIGEST_MISMATCH", "PackProof did not confirm the exact source original. Collection paused for review."); payload.Receipt = receipt; queue.Save(entry, payload, "awaiting_review", receipt.GetProperty("id").GetString()); entry = queue.Find(entry.Id)!; }
            else { receipt = await api.Request("GET", $"/v1/partner/imports/{Uri.EscapeDataString(entry.ImportId)}", null, state.Token, null, ct); payload.Receipt = receipt; }
            if (receipt.GetProperty("original").GetProperty("sha256").GetString()!=entry.Digest)throw new ConnectException("ORIGINAL_DIGEST_MISMATCH","The source receipt no longer describes this exact original. Collection paused for review.");
            var status = receipt.GetProperty("state").GetString();
            if (status == "previewed" && payload.CommitApproved)
            {
                var counts = receipt.GetProperty("counts"); var partial = Approved!.Value.GetProperty("importValidRows").GetBoolean(); if (!partial && (counts.GetProperty("invalid").GetInt32() > 0 || counts.GetProperty("ambiguous").GetInt32() > 0)) { queue.Save(entry, payload, "action_needed", error: "IMPORT_HAS_ROW_ERRORS"); return; }
                payload.CommitWireBody ??= Json.Bytes(new { previewVersion = receipt.GetProperty("previewVersion").GetString(), importValidRows = partial }); payload.CommitBodySha256 ??= Convert.ToHexStringLower(SHA256.HashData(payload.CommitWireBody)); queue.Save(entry, payload, "commit_pending"); entry = queue.Find(entry.Id)!; receipt = await api.Request("POST", $"/v1/partner/imports/{Uri.EscapeDataString(entry.ImportId!)}/commit", new ExactJsonBody(payload.CommitWireBody, payload.CommitBodySha256), state.Token, entry.CommitKey, ct); if (receipt.TryGetProperty("value", out var wrapped)) receipt = wrapped; payload.Receipt = receipt; status = receipt.GetProperty("state").GetString();
            }
            var next = status switch { "succeeded" => "complete", "partially_succeeded" => "partial", "failed" or "action_needed" => "action_needed", "previewed" => "awaiting_review", _ => "server_processing" }; if(next=="complete")ValidateReconciledReceipt(receipt,entry.Digest);
            queue.Save(entry, payload, next); if (next == "complete") { state.LastCompletedImportAt = receipt.TryGetProperty("updatedAt",out var acceptedAt)?acceptedAt.GetDateTimeOffset():DateTimeOffset.UtcNow; state.LastReceiptReconciledAt = DateTimeOffset.UtcNow; }
        }
        catch (ApiException e) { var current = queue.Find(entry.Id) ?? entry; queue.Save(current, payload, e.Transient ? current.State : "action_needed", error: e.Code, failed: e.Transient, retryAfter: e.RetryAfter); state.LastErrorCode = e.Code; if (!e.Transient && !IsSourceItemError(e.Code)) state.LocalPaused = true; throw; }
        catch (ConnectException e) { queue.Save(entry, payload, "action_needed", error: e.Code); state.LastErrorCode = e.Code; state.LocalPaused = true; throw; }
        catch (Exception e) when(e is KeyNotFoundException or InvalidOperationException or FormatException) { queue.Save(entry,payload,"action_needed",error:"IMPORT_RECONCILIATION_FAILED");state.LastErrorCode="IMPORT_RECONCILIATION_FAILED";state.LocalPaused=true;throw new ConnectException("IMPORT_RECONCILIATION_FAILED","The server receipt is incomplete. Preserve the queued original and ask support to reconcile its durable row outcomes."); }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { networkOnline = false; var current = queue.Find(entry.Id) ?? entry; queue.Save(current, payload, current.State, error: "NETWORK_UNAVAILABLE", failed: true); state.LastErrorCode = "NETWORK_UNAVAILABLE"; throw; }
    }
    private static bool IsSourceItemError(string code)=>code is "INVALID_CSV" or "CSV_ENCODING_UNSUPPORTED" or "CSV_ROW_LIMIT" or "MAPPING_NEEDS_REVIEW" or "SOURCE_BACKFILL_BOUNDARY" or "IMPORT_HAS_ROW_ERRORS" or "CSV_TOO_LARGE";
    internal static void ValidateReconciledReceipt(JsonElement receipt,string expectedDigest)
    {
        try {
        if(receipt.GetProperty("original").GetProperty("sha256").GetString()!=expectedDigest)throw new ConnectException("ORIGINAL_DIGEST_MISMATCH","The completed source receipt must confirm the exact queued original.");
        var rows=receipt.GetProperty("rows").EnumerateArray().ToArray(); var ids=new HashSet<string>(); var numbers=new HashSet<int>();
        if(rows.Length==0)throw new ConnectException("IMPORT_RECONCILIATION_FAILED","A completed import needs every row outcome and its canonical record.");
        foreach(var row in rows){
            var status=row.GetProperty("status").GetString();
            if(status is not("imported" or "duplicate")||!numbers.Add(row.GetProperty("rowNumber").GetInt32())||!row.TryGetProperty("proofId",out var proof)||string.IsNullOrEmpty(proof.GetString()))throw new ConnectException("IMPORT_RECONCILIATION_FAILED","Every accepted row needs one authorized canonical record association.");
            ids.Add(proof.GetString()!);
        }
        var counts=receipt.GetProperty("counts");
        if(counts.GetProperty("imported").GetInt32()!=rows.Count(row=>row.GetProperty("status").GetString()=="imported")||counts.GetProperty("duplicate").GetInt32()!=rows.Count(row=>row.GetProperty("status").GetString()=="duplicate")||new[]{"valid","invalid","ambiguous","failed"}.Any(k=>counts.GetProperty(k).GetInt32()!=0)||!ids.SetEquals(receipt.GetProperty("recordIds").EnumerateArray().Select(x=>x.GetString()!)))throw new ConnectException("IMPORT_RECONCILIATION_FAILED","Source totals and canonical record receipts did not reconcile. Preserve the queue for review.");
        } catch(Exception e) when(e is KeyNotFoundException or InvalidOperationException or FormatException) {throw new ConnectException("IMPORT_RECONCILIATION_FAILED","A completed receipt is missing its exact row accounting or record associations.");}
    }
    private async Task Verify(CancellationToken ct)
    {
        var entry = SetupEntry(); var receipt = queue.Payload(entry).Receipt; if (entry.State != "complete" || receipt is null) throw new ConnectException("IMPORT_NOT_COMPLETE", "Wait for the durable import and all row outcomes before verifying."); var ids = receipt.Value.GetProperty("recordIds").EnumerateArray().Select(x => x.GetString()).Where(x => x is not null).ToArray(); if (ids.Length == 0) throw new ConnectException("RECORD_REQUIRED", "The completed setup import did not produce a visible accepted record."); foreach (var id in ids) await api.Request("GET", $"/v1/partner/proofs/{Uri.EscapeDataString(id!)}", null, state.Token, null, ct); state.VerifiedRecordId = ids[0]; Save();
    }
    public async Task Tick(CancellationToken ct)
    {
        await gate.WaitAsync(ct); try
        {
            if (startupError is not null || checkpointed || state.Token is null) return;
            if (DateTimeOffset.UtcNow - lastCleanup >= TimeSpan.FromMinutes(1)) { queue.CompactCompleted(DateTimeOffset.UtcNow); lastCleanup = DateTimeOffset.UtcNow; }
            if(state.PendingToken is not null||state.RenewalKey is not null){
                if(state.NextRenewalAttemptAt>DateTimeOffset.UtcNow)return;
                try{if(state.PendingToken is not null)await CompleteRenewal(ct);else await Renew(ct);}
                catch(ApiException ack)when(!ack.Transient){checkpointed=true;state.LocalPaused=true;state.LastErrorCode="CREDENTIAL_RECOVERY_REQUIRED";Save();}
                return;
            }
            if (DateTimeOffset.UtcNow - lastRefresh >= TimeSpan.FromSeconds(60)) { try { await Refresh(ct); } catch (Exception e) when (e is ApiException or HttpRequestException or TaskCanceledException) { networkOnline = false; lastRefresh = DateTimeOffset.UtcNow; state.LastErrorCode = e is ApiException a ? a.Code : "NETWORK_UNAVAILABLE"; if (e is ApiException authority && authority.Status is 401 or 403) { state.LocalPaused = true; Save(); return; } } }
            var next = CurrentEntries().FirstOrDefault(x => x.State is not ("complete" or "partial" or "action_needed" or "awaiting_review") && x.NextAttemptAt <= DateTimeOffset.UtcNow);
            if (next is not null && networkOnline && !checkpointed && !state.LocalPaused && ServerState == "active") await Process(next, ct);
            // Setup accepted work can be polled while automatic reads remain disabled.
            if (networkOnline && state.SetupQueueId is not null) { var setup = queue.Find(state.SetupQueueId); if (setup?.State == "server_processing" && setup.NextAttemptAt <= DateTimeOffset.UtcNow) await Process(setup, ct); }
            if (state.CredentialExpiresAt - DateTimeOffset.UtcNow < TimeSpan.FromDays(7)) { if (networkOnline) await Renew(ct); return; }
            if (!MayCollect(DateTimeOffset.UtcNow) || DateTimeOffset.UtcNow - lastScan < TimeSpan.FromSeconds(30) || CurrentEntries().Any(x => x.State is "preview_pending" or "commit_pending" or "server_processing")) return;
            if (state.Folder is null) return; lastScan = DateTimeOffset.UtcNow; _ = FolderSource.Inventory(state.Folder); state.LastScanAt = DateTimeOffset.UtcNow;
            var knownEntries = queue.Entries().Select(x => x.Id).ToHashSet();
            foreach (var path in FolderSource.ScanBatch(Directory.EnumerateFiles(state.Folder, "*.csv", SearchOption.TopDirectoryOnly),state.ScanCursorFileName))
            {
                if (!MayCollect(DateTimeOffset.UtcNow)) break;
                state.ScanCursorFileName=Path.GetFileName(path);
                byte[] bytes;
                try { bytes=FolderSource.Snapshot(state.Folder,Path.GetFileName(path)); }
                catch(ConnectException rejected) when(rejected.Code is "CSV_SIZE_UNSUPPORTED" or "SOURCE_CHANGED") { state.LastErrorCode=rejected.Code; continue; }
                QueueEntry staged;
                try { _ = FolderSource.Preview(bytes); FolderSource.ValidateContract(bytes,Approved!.Value); staged = queue.Stage(bytes, Path.GetFileName(path), new(Approved!.Value), Generation, QueueConfigIdentity, true); }
                catch(ConnectException invalid) when(IsSourceItemError(invalid.Code)) { staged=queue.Quarantine(bytes,Path.GetFileName(path),Generation,QueueConfigIdentity,invalid.Code); state.LastErrorCode=invalid.Code; }
                if (knownEntries.Add(staged.Id)) state.LastExportAt = DateTimeOffset.UtcNow;
            }
            Save();
        }
        catch (Exception e) when (e is ConnectException or ApiException or HttpRequestException or TaskCanceledException or IOException or UnauthorizedAccessException) { state.LastErrorCode = e switch { ConnectException c => c.Code, ApiException a => a.Code, IOException => "LOCAL_STORAGE_UNAVAILABLE", UnauthorizedAccessException => "SOURCE_ACCESS_DENIED", _ => "NETWORK_UNAVAILABLE" }; if(state.RenewalKey is not null&&(e is HttpRequestException or TaskCanceledException||e is ApiException retry&&retry.Transient)){state.RenewalAttempts++;state.NextRenewalAttemptAt=DateTimeOffset.UtcNow.AddSeconds(Math.Min(300,2*Math.Pow(2,Math.Min(state.RenewalAttempts,8))));}
            if (e is IOException or UnauthorizedAccessException) state.LocalPaused = true; try { Save(); } catch (Exception storage) when (storage is IOException or UnauthorizedAccessException or ConnectException) { checkpointed = true; state.LocalPaused = true; } }
        finally { gate.Release(); }
    }
    private async Task Renew(CancellationToken ct)
    {
        if (CurrentEntries().Any(x => x.State is not ("complete" or "partial" or "action_needed"))) return;
        // Local staging stays intact; all accepted old-credential imports must be terminal first.
        state.RenewalKey ??= Guid.NewGuid().ToString("N"); Save(); var r = await api.Request("POST", "/v1/partner/agent/credential-renewals", new { }, state.Token, state.RenewalKey, ct); if (r.TryGetProperty("state", out var renewalState) && renewalState.GetString() is "cancelled" or "expired") { state.RenewalKey = null; Save(); return; }
        state.PendingToken = r.GetProperty("token").GetString(); state.PendingCredentialId = r.GetProperty("credentialId").GetString(); state.CredentialExpiresAt = r.GetProperty("expiresAt").GetDateTimeOffset(); try { Save(); } catch { var failedId = state.PendingCredentialId; try { await api.Request("POST", "/v1/partner/agent/credential-renewals", new { cancelCredentialId = failedId }, state.Token, state.RenewalKey + "-cancel", ct); } catch (Exception e) when (e is ApiException or HttpRequestException or TaskCanceledException) { } state.PendingToken = null; state.PendingCredentialId = null; checkpointed = true; state.LocalPaused = true; throw; }
        await CompleteRenewal(ct);
    }
    private async Task CompleteRenewal(CancellationToken ct)
    {
        var r = await api.Request("POST", "/v1/partner/agent/heartbeat", new { version = "0.1.0", renewalAcknowledged = true, queueCount = CurrentEntries().Count(x => x.State != "complete"), lastScanAt = state.LastScanAt, lastExportAt = state.LastExportAt, lastReceiptReconciledAt = state.LastReceiptReconciledAt, lastErrorCode = state.LastErrorCode }, state.PendingToken, null, ct); state.Token = state.PendingToken; state.PendingToken = null; state.PendingCredentialId = null; state.RenewalKey = null;state.RenewalAttempts=0;state.NextRenewalAttemptAt=null; RequireReasonableClock(DateTimeOffset.UtcNow); state.ServerConfig = r; state.LastPolicyCheckAt = DateTimeOffset.UtcNow; Save();
    }
    public void Dispose() { queue?.Checkpoint(); queue?.Dispose(); api.Dispose(); gate.Dispose(); }
}
