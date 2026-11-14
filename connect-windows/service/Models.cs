using System.Text.Json;
using System.Text.Json.Serialization;
namespace PackProof.Connect;

public sealed class ConnectException(string code, string message) : Exception(message) { public string Code { get; } = code; }
public static class Json
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
    public static byte[] Bytes<T>(T value) => JsonSerializer.SerializeToUtf8Bytes(value, Options);
    public static T Read<T>(ReadOnlySpan<byte> value) => JsonSerializer.Deserialize<T>(value, Options) ?? throw new ConnectException("LOCAL_STATE_INVALID", "Protected local state is unavailable. Preserve the queue and contact support.");
    public static JsonElement Element<T>(T value) => JsonSerializer.SerializeToElement(value, Options);
}
public sealed record HostConfiguration(string Environment, string ApiOrigin, string WebOrigin, string OperatorsSid)
{
    public string Suffix => Environment switch { "development" => "Development", "staging" => "Staging", "live" => "Production", _ => throw new ConnectException("ENVIRONMENT_INVALID", "This installation has no approved environment.") };
    public string ServiceName => $"PackProofConnect{Suffix}";
    public string PipeName => $"PackProofConnect-{(Environment == "live" ? "production" : Environment)}-v1";
    public string DataRoot => Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.CommonApplicationData), "PackProof", "Connect", Environment);
    public void Validate()
    {
        _ = Suffix;
        foreach (var origin in new[] { ApiOrigin, WebOrigin })
        {
            if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0 || uri.AbsolutePath != "/")
                throw new ConnectException("TRUSTED_ORIGIN_INVALID", "The installed PackProof endpoint configuration is invalid.");
        }
        if (!System.Text.RegularExpressions.Regex.IsMatch(OperatorsSid, @"^S-1-(?:[0-9]+-)*[0-9]+$")) throw new ConnectException("OPERATORS_SID_INVALID", "The installed local operator identity is invalid.");
        if (OperatingSystem.IsWindows()) _ = new System.Security.Principal.SecurityIdentifier(OperatorsSid);
    }
}
public sealed class LocalState
{
    public int StateVersion { get; set; } = 1;
    public List<SourceSubscriptionState> SourceSubscriptions { get; set; } = [];
    public string? LastScheduledSourceId { get; set; }
    public SubscriptionDraftState? SubscriptionDraft { get; set; }
    public JsonElement? LocalAnalysis { get; set; }
    public int DraftRevision { get; set; }
    public string[]? ExcludedFileNames { get; set; }
    public string? BaselineSha256 { get; set; }
    public string? BaselineObservedAt { get; set; }
    public bool GuidedSetup { get; set; }
    public string? GuidedProposalSha256 { get; set; }
    public string? GuidedFileSha256 { get; set; }
    public string? GuidedPhase { get; set; }
    public string? VerifiedSetupImportId { get; set; }
    public string? Token { get; set; }
    public string? InstallationId { get; set; }
    public DateTimeOffset? CredentialExpiresAt { get; set; }
    public string? EnrollmentId { get; set; }
    public string? RedeemSecret { get; set; }
    public string? ComparisonCode { get; set; }
    public string? ApprovalPath { get; set; }
    public DateTimeOffset? EnrollmentExpiresAt { get; set; }
    public DateTimeOffset? LastEnrollmentPollAt { get; set; }
    public string? EnrollmentState { get; set; }
    public string? Folder { get; set; }
    public string? FileName { get; set; }
    public string? FileDigest { get; set; }
    public string? FolderDigest { get; set; }
    public JsonElement? ServerConfig { get; set; }
    public DateTimeOffset? LastPolicyCheckAt { get; set; }
    public DateTimeOffset? LastScanAt { get; set; }
    public string? ScanCursorFileName { get; set; }
    public DateTimeOffset? LastExportAt { get; set; }
    public DateTimeOffset? LastCompletedImportAt { get; set; }
    public DateTimeOffset? LastReceiptReconciledAt { get; set; }
    public string? LastErrorCode { get; set; }
    public string? SetupQueueId { get; set; }
    public string? VerifiedRecordId { get; set; }
    public bool LocalPaused { get; set; } = true;
    public string? PauseAuthorizationTimestamp { get; set; }
    public string? RenewalKey { get; set; }
    public int RenewalAttempts { get; set; }
    public DateTimeOffset? NextRenewalAttemptAt { get; set; }
    public string? PendingToken { get; set; }
    public string? PendingCredentialId { get; set; }
    public DateTimeOffset? CredentialRecoveryConfirmedAt { get; set; }
    public bool RecoveryPrepared { get; set; }
}
public sealed record QueueEntry(string Id, string Digest, string State, string PreviewKey, string CommitKey, string CredentialGeneration, string ConfigDigest, string? ImportId, int Attempts, DateTimeOffset NextAttemptAt, string? ErrorCode, string PayloadPath, string SourceId = SourceSubscriptionState.LegacyId, string SourceProfile = SourceSubscriptionState.LegacyProfile, int GrantRevision = 0);
public sealed class QueuePayload
{
    public required string FileName { get; set; }
    public required string Csv { get; set; }
    public required JsonElement PreviewBody { get; set; }
    public byte[]? PreviewWireBody { get; set; }
    public string? PreviewBodySha256 { get; set; }
    public byte[]? CommitWireBody { get; set; }
    public string? CommitBodySha256 { get; set; }
    public JsonElement? Receipt { get; set; }
    public bool CommitApproved { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public bool OriginalCompacted { get; set; }
    public byte[]? QuarantinedOriginalBytes { get; set; }
}
public sealed record PipeRequest(int Version, string Id, string Operation, JsonElement? Payload);

public sealed record ExactJsonBody(byte[] Bytes, string Sha256);
