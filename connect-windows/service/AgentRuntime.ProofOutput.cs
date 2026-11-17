using System.Text.Json;

namespace PackProof.Connect;

public sealed partial class LocalState
{
    public ProofOutputConfiguration? ProofOutput { get; set; }
}

public sealed class ProofOutputConfiguration
{
    public required string Folder { get; set; }
    public required string Writer { get; set; }
    public string? InstallationId { get; set; }
    public long Cursor { get; set; }
    public long LastPublishedSequence { get; set; }
    public int? CompletedRevision { get; set; }
    public string State { get; set; } = "ready";
    public string? ErrorCode { get; set; }
    public bool HasMore { get; set; }
    public DateTimeOffset? RequestRetryAt { get; set; }
    public int FeedFailures { get; set; }
    public List<ProofOutputJob> Jobs { get; set; } = [];
    public string[] PhysicalPath { get; set; } = [];
    public List<PreviousProofFolder> PreviousFolders { get; set; } = [];
}
public sealed record PreviousProofFolder(string Folder, string[] PhysicalPath);
public sealed record ProofOutputJob(long Sequence, string ProofId, int Revision)
{
    public int Attempts { get; set; }
    public DateTimeOffset? NextAttemptAt { get; set; }
    public string? ErrorCode { get; set; }
}

public sealed partial class AgentRuntime
{
    private DateTimeOffset nextOutputFetch = DateTimeOffset.MinValue;
    internal string? ProofOutputFolder => state.ProofOutput?.Folder;
    internal string ProofOutputState => state.ProofOutput?.State ?? "not_configured";

    internal object ReadProofOutput() => new {
        folder=ProofOutputFolder, state=ProofOutputState, errorCode=state.ProofOutput?.ErrorCode,
        pending=state.ProofOutput?.Jobs.Count ?? 0, completedRevision=state.ProofOutput?.CompletedRevision,
        backlogContinues=state.ProofOutput?.HasMore ?? false, cursor=state.ProofOutput?.Cursor ?? 0
    };

    private IEnumerable<string> ForbiddenOutputRoots(IEnumerable<string> sources)
    {
        var protectedRoots = new List<string>{ store.Root };
        if (OperatingSystem.IsWindows())
        {
            protectedRoots.AddRange(new[]{Environment.SpecialFolder.Windows,Environment.SpecialFolder.ProgramFiles,
                    Environment.SpecialFolder.ProgramFilesX86}.Select(Environment.GetFolderPath));
            var data = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            if (!string.IsNullOrWhiteSpace(data))
            {
                var shared = Path.Combine(data,"PackProof","Connect");
                if (Directory.Exists(shared)) protectedRoots.Add(shared);
            }
        }
        return protectedRoots.Concat(sources).Where(p=>!string.IsNullOrWhiteSpace(p)).Distinct(StringComparer.OrdinalIgnoreCase);
    }

    private IEnumerable<string> CurrentProofSourceRoots() => WorkspaceSourceFolders
        .Concat(state.SourceSubscriptions.Select(s=>s.Folder).OfType<string>())
        .Concat(new[]{state.Folder}.OfType<string>());

    internal void ValidateProofSourceFolder(string folder)
    {
        ValidateCollectingProofSource(folder);
        if (ProofOutputFolder is not { } output) return;
        ProofOutputPaths.LexicalCheck(folder,new[]{output});
        try
        {
            using var source = new ProofOutputPaths.DirectoryPin(folder);
            source.Exclude(output);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            throw new ConnectException("OUTPUT_PATH_CHECK_REQUIRED",
                "Reconnect the source and proof folders so PackProof can check that they are separate.");
        }
    }

    internal void ValidateCollectingProofSource(string folder)
    {
        var protectedRoots = ForbiddenOutputRoots([]).ToArray();
        using var source = ProofOutputPaths.Verify(folder,protectedRoots);
        for(var ancestor=new DirectoryInfo(folder);ancestor!=null;ancestor=ancestor.Parent)
            if (File.Exists(Path.Combine(ancestor.FullName,".packproof-writer.id")))
                throw new ConnectException("OUTPUT_PATH_UNSAFE","Choose a source folder outside saved PackProof files.");
        if (state.ProofOutput is not { } target) return;
        foreach(var previous in target.PreviousFolders.Append(new(target.Folder,target.PhysicalPath)))
        {
            ProofOutputPaths.LexicalCheck(folder,new[]{previous.Folder});
            source.ExcludeKeys(previous.PhysicalPath);
        }
    }

    internal void ConfigureProofOutput(string folder, IEnumerable<string> sourceRoots)
    {
        var fullPath = ProofOutputPaths.Normalize(folder);
        var roots = ForbiddenOutputRoots(sourceRoots).ToArray();
        ProofOutputPaths.LexicalCheck(fullPath,roots);
        var current = state.ProofOutput;
        var candidate = current is not null && string.Equals(current.Folder,fullPath,StringComparison.OrdinalIgnoreCase)
            ? current : new ProofOutputConfiguration { Folder=fullPath, Writer=current?.Writer ?? Guid.NewGuid().ToString("N"),
                PreviousFolders=current is null ? [] : current.PreviousFolders.Append(new(current.Folder,current.PhysicalPath))
                    .Where(p=>!string.Equals(p.Folder,fullPath,StringComparison.OrdinalIgnoreCase))
                    .DistinctBy(p=>p.Folder,StringComparer.OrdinalIgnoreCase).ToList() };
        try
        {
            using var pin = ProofOutputPaths.Verify(fullPath,roots);
            ProofOutputBundle.Probe(fullPath);
            // Bind at configure time so a second installation gets an actionable
            // selection error before it starts requesting order data.
            using var writer = new ProofOutputBundle(fullPath,candidate.Writer);
            candidate.PhysicalPath=pin.KeyStrings;
            candidate.State = candidate.Jobs.Count > 0 ? "pending" : candidate.CompletedRevision.HasValue ? "current" : "ready";
            candidate.ErrorCode = null;
        }
        catch (UnauthorizedAccessException)
        {
            candidate.State = "access_denied"; candidate.ErrorCode = "OUTPUT_ACCESS_DENIED";
        }
        catch (IOException e)
        {
            candidate.State = LocalIo.NativeError(e)==5 ? "access_denied" : "unavailable";
            candidate.ErrorCode = candidate.State=="access_denied" ? "OUTPUT_ACCESS_DENIED" : "OUTPUT_UNAVAILABLE";
        }
        // A new destination starts at sequence zero; the old packages remain.
        state.ProofOutput = candidate;
        nextOutputFetch = DateTimeOffset.MinValue;
        Save();
    }

    private static ConnectException InvalidFeed() => new("OUTPUT_FEED_INVALID",
        "PackProof could not verify a committed order update. The saved copy is preserved.");
    private static bool IsProofId(string? value) => value is { Length:>0 and <=128 } &&
        value.All(c=>char.IsAsciiLetterOrDigit(c) || c is '-' or '_');

    private async Task FetchOutputJobs(ProofOutputConfiguration target, CancellationToken ct)
    {
        var limit = Math.Min(12,64-target.Jobs.Count);
        if (limit<=0) return;
        var page = await api.Request("POST","/v1/partner/agent/order-changes",
            new { after=target.Cursor,limit },state.Token,null,ct);
        var changes = page.GetProperty("changes");
        var next = page.GetProperty("nextCursor").GetInt64();
        var hasMore = page.GetProperty("hasMore").GetBoolean();
        if (changes.ValueKind!=JsonValueKind.Array || changes.GetArrayLength()>limit || next<target.Cursor) throw InvalidFeed();
        var jobs = new List<ProofOutputJob>();
        var last = target.Cursor;
        foreach (var row in changes.EnumerateArray())
        {
            var seq = row.GetProperty("sequence").GetInt64();
            var proof = row.GetProperty("proofId").GetString();
            var revision = row.GetProperty("revision").GetInt32();
            if (seq<=last || seq>next || revision<1 || !IsProofId(proof)) throw InvalidFeed();
            jobs.Add(new(seq,proof!,revision));
            last=seq;
        }
        if (hasMore && next==target.Cursor) throw InvalidFeed();
        if (jobs.Count>0 || next!=target.Cursor || target.HasMore!=hasMore)
        {
            // The checkpoint and requested revisions reach protected storage in
            // the same atomic replace. Crash replay may repeat publication.
            target.Jobs.AddRange(jobs); target.Cursor=next; target.HasMore=hasMore;
            if (jobs.Count>0) target.State="pending";
            Save();
        }
    }

    private async Task PublishOutputRevision(ProofOutputBundle writer,ProofOutputJob job,CancellationToken ct)
    {
        var revision=await api.Request("GET",$"/v1/partner/agent/order-proofs/{job.ProofId}/revisions/{job.Revision}",null,state.Token,null,ct);
        ct.ThrowIfCancellationRequested();
        RememberWorkspaceRevision(revision,job.ProofId,job.Revision);
        var originals=new List<ProofOutputBundle.ManifestEntry>();
        if(revision.TryGetProperty("originalArtifacts",out var artifacts))
        {
            if(artifacts.ValueKind!=JsonValueKind.Array || artifacts.GetArrayLength()>512)throw InvalidFeed();
            foreach(var binding in artifacts.EnumerateArray())
            {
                var receipt=binding.GetProperty("receiptId").GetString();
                if(!IsProofId(receipt))throw InvalidFeed();
                var path=$"/v1/partner/agent/order-proofs/{job.ProofId}/revisions/{job.Revision}/artifacts/{receipt}";
                var artifact=await api.Request("GET",path,null,state.Token,null,ct);
                originals.Add(writer.StoreLinkedOriginal(revision,job.ProofId,binding,artifact));
            }
        }
        writer.Publish(revision,job.ProofId,job.Revision,originals);
    }

    internal async Task TickProofOutput(CancellationToken ct)
    {
        var target = state.ProofOutput;
        if (target is null || !WorkspaceAllowsProofOutput || state.Token is null || state.InstallationId is null ||
            state.CredentialExpiresAt<=DateTimeOffset.UtcNow || ServerState=="revoked" || checkpointed) return;
        if (target.InstallationId!=null && target.InstallationId!=state.InstallationId) return;
        if (target.InstallationId==null) { target.InstallationId=state.InstallationId; Save(); }
        var now=DateTimeOffset.UtcNow;
        if (target.RequestRetryAt>now) return;
        var fetchDue = nextOutputFetch<=now;
        if (!fetchDue && !target.Jobs.Any(j=>j.NextAttemptAt==null || j.NextAttemptAt<=now)) return;
        ProofOutputJob? job=null;
        try
        {
            if (fetchDue)
            {
                await FetchOutputJobs(target,ct);
                target.FeedFailures=0;
                target.RequestRetryAt=null;
                nextOutputFetch=now.AddSeconds(target.HasMore ? 1 : 5);
            }
            var due = target.Jobs.Where(j=>j.NextAttemptAt==null || j.NextAttemptAt<=now).ToArray();
            job=due.FirstOrDefault();
            if (job==null)
            {
                if (target.Jobs.Count==0 && target.State=="pending") { target.State="ready";target.ErrorCode=null;Save(); }
                return;
            }
            using var root=ProofOutputPaths.Verify(target.Folder,ForbiddenOutputRoots(CurrentProofSourceRoots()));
            if (target.PhysicalPath.Length>0 && !root.KeyStrings.SequenceEqual(target.PhysicalPath))
                throw new ConnectException("OUTPUT_LOCATION_CHANGED","The destination now points to a different folder. Verify and choose the intended folder again.");
            target.PhysicalPath=root.KeyStrings;
            using var writer=new ProofOutputBundle(target.Folder,target.Writer);
            // Publish the newest visible tip promptly while retaining older audit jobs.
            // A bounded turn gives intake and the next source a chance to run.
            var turn=System.Diagnostics.Stopwatch.StartNew();
            var newest=due.GroupBy(j=>j.ProofId).Select(g=>g.MaxBy(j=>j.Sequence)!).ToArray();
            foreach(var next in newest.Concat(due).DistinctBy(j=>j.Sequence).Take(4))
            {
                job=next;
                await PublishOutputRevision(writer,job,ct);
                target.Jobs.Remove(job);
                if(job.Sequence>=target.LastPublishedSequence) { target.LastPublishedSequence=job.Sequence;target.CompletedRevision=job.Revision; }
                if(turn.Elapsed>TimeSpan.FromSeconds(1))break;
            }
            target.State=target.Jobs.Count==0 && !target.HasMore ? "current" : "pending";
            target.ErrorCode=target.Jobs.FirstOrDefault(j=>j.ErrorCode!=null)?.ErrorCode;
        }
        catch(Exception error) when (error is IOException or UnauthorizedAccessException or ApiException or ConnectException or
            HttpRequestException or JsonException or KeyNotFoundException or FormatException or InvalidOperationException ||
            error is TaskCanceledException && !ct.IsCancellationRequested)
        {
            target.ErrorCode=error switch {
                ConnectException e=>e.Code, ApiException e=>e.Code, UnauthorizedAccessException=>"OUTPUT_ACCESS_DENIED",
                IOException e when LocalIo.NativeError(e)==5=>"OUTPUT_ACCESS_DENIED", IOException=>"OUTPUT_UNAVAILABLE",
                HttpRequestException or TaskCanceledException=>"OUTPUT_FEED_OFFLINE", _=>"OUTPUT_FEED_INVALID"
            };
            target.State=target.ErrorCode=="OUTPUT_ACCESS_DENIED" ? "access_denied" : "pending";
            if(job!=null)
            {
                job.Attempts=Math.Min(job.Attempts+1,30); job.ErrorCode=target.ErrorCode;
                job.NextAttemptAt=DurableQueue.RetryAt(now,job.Attempts,(error as ApiException)?.RetryAfter);
                if (error is ApiException { Status: 429 or 401 or 403 } || error is UnauthorizedAccessException or IOException ||
                    target.ErrorCode is "OUTPUT_LOCATION_CHANGED" or "OUTPUT_WRITER_CONFLICT")
                    target.RequestRetryAt=job.NextAttemptAt;
            }
            else
            {
                target.FeedFailures=Math.Min(target.FeedFailures+1,30);
                target.RequestRetryAt=error is ApiException { Transient:false }
                    ? now.AddSeconds(30) : DurableQueue.RetryAt(now,target.FeedFailures,(error as ApiException)?.RetryAfter);
                nextOutputFetch=target.RequestRetryAt.Value;
            }
        }
        Save();
    }
}
