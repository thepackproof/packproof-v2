using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
namespace PackProof.Connect;

/// <summary>Protected source-local state. It carries no replacement credential;
/// queued work retains its original installation, credential and approval.</summary>
public sealed class SourceSubscriptionState
{
    public const string LegacyId = "legacy";
    public const string LegacyProfile = "shipment-csv/v1";
    public required string Id { get; set; }
    public string SourceProfile { get; set; } = LegacyProfile;
    public string? Folder { get; set; }
    public string? FolderDigest { get; set; }
    public JsonElement? ApprovedConfiguration { get; set; }
    public string ConfigurationSha256 { get; set; } = "none";
    public int ConfigurationRevision { get; set; }
    public int GrantRevision { get; set; }
    public string ServerState { get; set; } = "needs_approval";
    public bool LocalPaused { get; set; } = true;
    public string? PauseAuthorizationTimestamp { get; set; }
    public DateTimeOffset? LastPolicyCheckAt { get; set; }
    public DateTimeOffset? LastCheckAt { get; set; }
    public DateTimeOffset? LastCollectedAt { get; set; }
    public DateTimeOffset? LastReceiptAt { get; set; }
    public string? CursorFileName { get; set; }
    public string? LastErrorCode { get; set; }
    public Dictionary<string,string> PublishedFileDigests { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public string[] ExcludedFileNames { get; set; } = [];
    public string? SelectedFileName { get; set; }
    public string? SelectedFileSha256 { get; set; }
    public JsonElement? LocalPreview { get; set; }
    public JsonElement? ServerView { get; set; }
    public bool CapabilityApproved { get; set; }
    public string? SetupQueueId { get; set; }
    public string? VerifiedCaseId { get; set; }
    public string QueueConfigurationIdentity(string? installationId) => QueueConfigurationIdentity(installationId,GrantRevision);
    // Completed-original erasure uses a new current authorization while checking
    // the immutable capture identity. It never changes a queued work item's grant.
    internal string QueueConfigurationIdentity(string? installationId,int receiptGrantRevision) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"{installationId ?? "unenrolled"}:{Id}:{ConfigurationSha256}:{ConfigurationRevision}:{receiptGrantRevision}")));
}
public sealed record QueueSourceIdentity(string SourceId, string SourceProfile, int GrantRevision);

public static class SourceStateMigration
{
    public const int Version = 3;
    public static void Validate(LocalState state)
    {
        if (state.StateVersion is < 1 or > Version || state.SourceSubscriptions is null || state.SourceSubscriptions.Select(s => s.Id).Distinct(StringComparer.Ordinal).Count() != state.SourceSubscriptions.Count)
            throw new ConnectException("LOCAL_STATE_UNSUPPORTED", "Install the compatible collector. Protected approvals and pending originals have been preserved.");
    }
    public static void SynchronizeLegacy(LocalState state)
    {
        Validate(state);
        var legacy = state.SourceSubscriptions.SingleOrDefault(s => s.Id == SourceSubscriptionState.LegacyId);
        if (legacy is null)
        {
            legacy = new() { Id = SourceSubscriptionState.LegacyId };
            state.SourceSubscriptions.Add(legacy);
        }
        legacy.SourceProfile = SourceSubscriptionState.LegacyProfile;
        legacy.Folder = state.Folder; legacy.FolderDigest = state.FolderDigest;
        legacy.LocalPaused = state.LocalPaused; legacy.PauseAuthorizationTimestamp = state.PauseAuthorizationTimestamp;
        legacy.LastPolicyCheckAt = state.LastPolicyCheckAt; legacy.LastCheckAt = state.LastScanAt;
        legacy.LastCollectedAt = state.LastExportAt; legacy.LastReceiptAt = state.LastReceiptReconciledAt;
        legacy.CursorFileName = state.ScanCursorFileName; legacy.LastErrorCode = state.LastErrorCode;
        legacy.SetupQueueId = state.SetupQueueId;
        if (state.ServerConfig is { } server)
        {
            legacy.ApprovedConfiguration = server.TryGetProperty("config", out var config) && config.ValueKind == JsonValueKind.Object ? config : null;
            legacy.ConfigurationSha256 = server.TryGetProperty("configSha256", out var digest) ? digest.GetString() ?? "none" : "none";
            legacy.ConfigurationRevision = server.TryGetProperty("configRevision", out var revision) ? revision.GetInt32() : 0;
            legacy.ServerState = server.TryGetProperty("state", out var status) ? status.GetString() ?? "needs_approval" : "needs_approval";
        }
        // This migration does not reinterpret old CSV permissions as typed-source
        // approval, nor rewrite any old queue configuration/credential identity.
        legacy.CapabilityApproved = false;
        state.StateVersion = Version;
    }
}

public sealed class SubscriptionDraftState
{
    public required string Folder { get; set; }
    public required string FolderDigest { get; set; }
    public string[] ExcludedFileNames { get; set; } = [];
    public string? SelectedFileName { get; set; }
    public string? SelectedFileSha256 { get; set; }
    public JsonElement? LocalPreview { get; set; }
    public JsonElement? Proposal { get; set; }
    public string? ApprovalPath { get; set; }
}
