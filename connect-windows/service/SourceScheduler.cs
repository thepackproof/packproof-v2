namespace PackProof.Connect;

/// <summary>Bounded, round-robin work. A source failure cannot starve peers;
/// shared storage/installation failures deliberately escape to stop admission.</summary>
public sealed class SourceScheduler
{
    public static bool IsSharedSafetyFailure(Exception error) => error is ConnectException c &&
        (c.Code.StartsWith("LOCAL_STORAGE_", StringComparison.Ordinal) || c.Code.StartsWith("SPOOL_", StringComparison.Ordinal) || c.Code is "PROTECTED_STORAGE_UNAVAILABLE" or "QUEUE_SCHEMA_UNSUPPORTED" or "CREDENTIAL_RECOVERY_REQUIRED")
        || error is IOException or UnauthorizedAccessException;
    public static IReadOnlyList<SourceSubscriptionState> Order(IEnumerable<SourceSubscriptionState> subscriptions, string? afterId, int budget = 3, bool includePaused = false)
    {
        if (budget is < 1 or > 10) throw new ArgumentOutOfRangeException(nameof(budget));
        var all = subscriptions.Where(s => s.Id != SourceSubscriptionState.LegacyId && s.CapabilityApproved && (includePaused || !s.LocalPaused)).OrderBy(s => s.Id, StringComparer.Ordinal).ToArray();
        if (all.Length == 0) return [];
        var start = afterId is null ? 0 : Array.FindIndex(all, s => string.CompareOrdinal(s.Id, afterId) > 0); if (start < 0) start = 0;
        return Enumerable.Range(0, Math.Min(budget, all.Length)).Select(n => all[(start + n) % all.Length]).ToArray();
    }
    public static async Task<string?> Run(IEnumerable<SourceSubscriptionState> subscriptions, string? afterId, Func<SourceSubscriptionState, CancellationToken, Task> work, CancellationToken ct, bool includePaused = false,int budget=3)
    {
        var last = afterId;
        foreach (var source in Order(subscriptions, afterId,budget:budget, includePaused:includePaused))
        {
            ct.ThrowIfCancellationRequested();
            try { await work(source, ct); }
            catch (Exception error) when (error is ConnectException or ApiException or HttpRequestException or TaskCanceledException)
            {
                if (ct.IsCancellationRequested) throw;
                if (IsSharedSafetyFailure(error) || error is ApiException api && (api.Status==401 || api.Code is "AGENT_AUTHORIZATION_REQUIRED" or "INSUFFICIENT_SCOPE" or "UNAUTHENTICATED")) throw;
                source.LastErrorCode = error switch { ConnectException c => c.Code, ApiException a => a.Code, _ => "NETWORK_UNAVAILABLE" };
                // A transient source/network error retains its retry identity.
                // Schema and scope errors need a new administrative review.
                if (error is ConnectException sourceError && sourceError.Code is not("SOURCE_BUSY" or "SOURCE_CHANGED") || error is ApiException denied && !denied.Transient) source.LocalPaused = true;
            }
            last = source.Id;
        }
        return last;
    }
}
public sealed record CollectedSourceFile(string Name, byte[] Bytes);
public interface ISourceAdapter : IDisposable
{
    IReadOnlyList<string> Inspect(SourceSubscriptionState source);
    CollectedSourceFile Read(SourceSubscriptionState source, string name);
}
public sealed class LocalNtfsSourceAdapter : ISourceAdapter
{
    public IReadOnlyList<string> Inspect(SourceSubscriptionState source)
    {
        if (source.Folder is null || source.FolderDigest is null) throw new ConnectException("SOURCE_REQUIRED", "Select the approved local export source.");
        var folder = FolderSource.Validate(source.Folder);
        var digest = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(folder.ToUpperInvariant())));
        if (digest != source.FolderDigest) throw new ConnectException("SOURCE_SCOPE_REVIEW_REQUIRED", "The local source differs from its approved folder. Review this source before reading files.");
        // Inventory enforces the dedicated-folder entry bound and NTFS/link rules.
        _ = FolderSource.Inventory(folder);
        var all=Directory.EnumerateFiles(folder,"*.csv",SearchOption.TopDirectoryOnly).ToArray();var unseen=all.Where(p=>!source.ExcludedFileNames.Contains(Path.GetFileName(p),StringComparer.OrdinalIgnoreCase)&&!source.PublishedFileDigests.ContainsKey(Path.GetFileName(p))).ToArray();
        return FolderSource.ScanBatch(unseen.Length>0?unseen:all,source.CursorFileName).Select(Path.GetFileName).Cast<string>().ToArray();
    }
    public CollectedSourceFile Read(SourceSubscriptionState source, string name) => new(name, FolderSource.Snapshot(source.Folder ?? "", name));
    public void Dispose() { }
}
