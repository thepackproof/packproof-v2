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
        source.InspectRole = role;
        source.Paused = false;
        source.Recognition = null;
        Invalidate();
        return source;
    }

    public WorkspaceSource ConnectPartner(string sourceNamespace)
    {
        if (sourceNamespace.Length is < 1 or > 100 || sourceNamespace.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.')))
            throw new ConnectException("SOURCE_NAMESPACE_INVALID", "Choose a system reference of up to 100 letters, digits, dots, dashes or underscores.");
        var existing = Sources.FirstOrDefault(s => s.Transport == "api" && s.SourceNamespace == sourceNamespace);
        if (existing is { Roles.Count: >0 }) return existing;
        if (existing is null && Sources.Count >= 24) throw new ConnectException("SOURCE_LIMIT", "This operation has reached its limit of 24 sources.");
        var source = existing ?? new WorkspaceSource { Id = Guid.NewGuid().ToString("N"), Folder = "", Transport = "api", SourceNamespace = sourceNamespace };
        if (existing is null) Sources.Add(source);
        else source.Generation = checked(source.Generation + 1);
        source.Roles = ["order"];
        source.Paused = false;
        source.Recognition = Json.Element(new { state = "empty", message = "Waiting for the first order from the PackProof Partner API.", fields = Array.Empty<string>() });
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
    public string Transport { get; set; } = "folder";
    public string? SourceNamespace { get; set; }
    public string DisplayName => Transport == "api" ? "PackProof Partner API" : Folder;
    public int Generation { get; set; } = 1;
    public string? PhysicalRoot { get; set; }
    public List<string> Roles { get; set; } = [];
    public JsonElement? Recognition { get; set; }
    public Dictionary<string,string> RelatedSources { get; set; } = [];
    public Dictionary<string,int> ConfirmedDependencies { get; set; } = [];
    public string? ObservedNamespace { get; set; }
    public string? InspectRole { get; set; }
    public List<WorkflowColumnMap> Workflows { get; set; } = [];
    public WorkflowColumnMap? ProposedWorkflow { get; set; }
    public WorkflowColumnMap? ConfirmedWorkflow { get; set; }
    public OrderColumnMap? ProposedMap { get; set; }
    public OrderColumnMap? ConfirmedMap { get; set; }
    public IEnumerable<WorkflowColumnMap> ApprovedWorkflows() =>
        Workflows.Concat(ConfirmedWorkflow is { } old ? new[] {old} : []).Where(m=>Roles.Contains(m.Role))
        .DistinctBy(SourceReaders.WorkflowProfileVersion);

    public string ProfileVersion
    {
        get
        {
            if (Transport == "api") return "packproof.partner-order/v1";
            var versions=ApprovedWorkflows().Select(SourceReaders.WorkflowProfileVersion).ToList();
            if (ConfirmedMap != null && Roles.Contains("order")) versions.Add(SourceReaders.OrderProfileVersion(ConfirmedMap));
            if (versions.Count == 0) return SourceReaders.ProfileId;
            if (versions.Count == 1) return versions[0];
            var bytes = Json.Bytes(versions.Order(StringComparer.Ordinal));
            return "packproof.order-profile-set/v1/" + Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes));
        }
    }
    public bool Paused { get; set; }
    public string? Cursor { get; set; }
    public DateTimeOffset? LastScanAt { get; set; }
    public DateTimeOffset? RetryAt { get; set; }
    public string? Issue { get; set; }
    public List<string> MediaJobs { get; set; } = [];
    public string? ApiHistoryState { get; set; }
    public int ApiHistoryGeneration { get; set; }
    public bool CoverageGap { get; set; }
    public string? PreviousCollectorId { get; set; }
    public bool ReplacesPreviousCollector { get; set; }
    public Dictionary<string, WorkspaceFileVersion> Inventory { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

public sealed record WorkspaceGrant(string InstallationId, string ScopeDigest, string OutputDigest, Dictionary<string,int> Generations,
    DateTimeOffset CheckedAt, int OfflineWindowSeconds);

public sealed record WorkspaceFileVersion(string Digest, long Sequence, int Generation, string Name, bool Missing = false);

