using System.Text.Json;

namespace PackProof.Connect;

public sealed partial class LocalState
{
    public OrderWorkspaceState? Workspace { get; set; }
}

public sealed class OrderWorkspaceState
{
    public const string History = "existing_and_future";
    public int Version { get; set; } = 1;
    public bool ContinueAfterEnrollment { get; set; }
    public bool AllowPendingOutput { get; set; }
    public WorkspaceGrant? ActiveGrant { get; set; }
    public string Step { get; set; } = "order";
    public string Phase { get; set; } = "draft";
    public string? InstallationId { get; set; }
    public string? ScopeDigest { get; set; }
    public string? ApprovalPath { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
    public DateTimeOffset? CheckedAt { get; set; }
    public int OfflineWindowSeconds { get; set; }
    public string? ApprovedOutputDigest { get; set; }
    public List<WorkspaceSource> Sources { get; set; } = [];
    public Dictionary<string,int> SubmittedGenerations { get; set; } = [];
    public string? LastScheduled { get; set; }
    public string? Attention { get; set; }

    public static bool IsRole(string role) => role is "order" or "picking" or "packing" or "shipping" or "handoff" or "delivery" or "returns" or "evidence";
    public static bool IsStep(string step) => IsRole(step) || step is "review" or "output" or "activate" or "overview";

    public WorkspaceSource Assign(string folder, string role)
    {
        if (!IsRole(role)) throw new ConnectException("SOURCE_ROLE_INVALID", "Choose one of the listed record types.");
        var source = Sources.FirstOrDefault(s => string.Equals(s.Folder, folder, StringComparison.OrdinalIgnoreCase));
        if (source is null)
        {
            if (Sources.Count >= 24) throw new ConnectException("SOURCE_LIMIT", "This operation has reached its limit of 24 folders.");
            source = new() { Id = Guid.NewGuid().ToString("N"), Folder = folder };
            Sources.Add(source);
        }
        else if (source.Roles.Contains(role)) return source;
        if (source.Roles.Count > 0 || source.Paused) source.Generation = checked(source.Generation + 1);
        source.Roles.Add(role);
        source.Paused = false;
        source.Recognition = null;
        Invalidate();
        return source;
    }

    public void Invalidate()
    {
        ContinueAfterEnrollment = false;
        Phase = "draft";
        ApprovalPath = null;
        ScopeDigest = null;
        ApprovedOutputDigest = null;
        CheckedAt = null;
        OfflineWindowSeconds = 0;
        ExpiresAt = null;
        Attention = null;
        SubmittedGenerations.Clear();
    }
}

public sealed class WorkspaceSource
{
    public required string Id { get; set; }
    public required string Folder { get; set; }
    public int Generation { get; set; } = 1;
    public List<string> Roles { get; set; } = [];
    public JsonElement? Recognition { get; set; }
    public OrderColumnMap? ProposedMap { get; set; }
    public OrderColumnMap? ConfirmedMap { get; set; }
    public string ProfileVersion => ConfirmedMap is null ? SourceReaders.ProfileId : SourceReaders.OrderProfileVersion(ConfirmedMap);
    public bool Paused { get; set; }
    public string? Cursor { get; set; }
    public DateTimeOffset? LastScanAt { get; set; }
    public DateTimeOffset? RetryAt { get; set; }
    public string? Issue { get; set; }
    public List<string> MediaJobs { get; set; } = [];
    public bool CoverageGap { get; set; }
    public string? PreviousCollectorId { get; set; }
    public bool ReplacesPreviousCollector { get; set; }
    public Dictionary<string, WorkspaceFileVersion> Inventory { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

public sealed record WorkspaceGrant(string InstallationId, string ScopeDigest, string OutputDigest, Dictionary<string,int> Generations,
    DateTimeOffset CheckedAt, int OfflineWindowSeconds);

public sealed record WorkspaceFileVersion(string Digest, long Sequence, int Generation, string Name);

