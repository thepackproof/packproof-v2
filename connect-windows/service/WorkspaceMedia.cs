using System.Security.Cryptography;
using System.Text.Json;

namespace PackProof.Connect;

public sealed partial class AgentRuntime
{
    // Native/OCR work must never hold the command or collection gate. Poll only
    // completed results there. A failed or interrupted child can be recreated
    // from its original authenticated spool entry after restart.
    private readonly CancellationTokenSource mediaLifetime = new();
    private Task<SourceReadResult>? mediaWork;
    private string? mediaEntryId;
    private DateTimeOffset nextMediaSend;

    private async Task AdvanceWorkspaceMedia(OrderWorkspaceState w,CancellationToken ct)
    {
        if (w.ActiveGrant is not { } grant || !WorkspaceGrantCurrent || mediaWork == null && DateTimeOffset.UtcNow < nextMediaSend) return;
        var eligible = w.Sources.Where(s => !s.Paused && grant.Generations.GetValueOrDefault(s.Id) == s.Generation);
        var chosen = eligible.SelectMany(s => s.MediaJobs.Select(id => (source:s,id)))
            .FirstOrDefault(x => mediaEntryId != null ? x.id == mediaEntryId : queue.Find(x.id)?.State == "complete");
        if (chosen.source == null)
        {
            if (mediaWork?.IsCompleted == true) { _ = mediaWork.Exception; mediaWork = null; mediaEntryId = null; }
            return;
        }
        var entry = queue.Find(chosen.id);
        if (entry == null || entry.State != "complete") return;
        var payload = queue.Payload(entry);
        if (payload.PreviewWireBody == null) return;
        var capture = Json.Read<JsonElement>(payload.PreviewWireBody);
        if (capture.GetProperty("generation").GetInt32() != chosen.source.Generation || entry.CredentialGeneration != grant.InstallationId) return;
        var cacheName = $"media-{entry.Id}.bin";
        var derived = store.Read<SourceReadResult>(cacheName);
        if (derived == null)
        {
            if (mediaWork == null)
            {
                var bytes = Convert.FromBase64String(capture.GetProperty("originalBase64").GetString()!);
                if (HashBytes(bytes) != entry.Digest) throw new ConnectException("SPOOL_DIGEST_MISMATCH","The retained media failed its integrity check.");
                mediaEntryId = entry.Id;
                mediaWork = Task.Run(() => SourceReaders.ReadDerivedAsync(payload.FileName,bytes,mediaLifetime.Token));
                return;
            }
            if (!mediaWork.IsCompleted) return;
            try { derived = await mediaWork; }
            catch (Exception error) when (error is not OutOfMemoryException)
            {
                chosen.source.Issue = "MEDIA_READER_UNAVAILABLE";
                // Preserve the immutable original. A transient decoder failure has a
                // capped retry delay and cannot prevent structured source uploads.
                chosen.source.MediaJobs.Remove(entry.Id);
                chosen.source.MediaJobs.Add(entry.Id);
                nextMediaSend = DateTimeOffset.UtcNow.AddMinutes(2);
                return;
            }
            finally { mediaWork = null; mediaEntryId = null; }
            if (derived.ContentSha256 != entry.Digest) throw new ConnectException("MEDIA_DIGEST_MISMATCH","The derived result identifies a different original.");
            if (derived.State == "recognized" && derived.Rows.Count == 0)
            {
                chosen.source.Issue = "MEDIA_READER_UNAVAILABLE";
                chosen.source.MediaJobs.Remove(entry.Id); chosen.source.MediaJobs.Add(entry.Id);
                nextMediaSend = DateTimeOffset.UtcNow.AddMinutes(2); return;
            }
            var size = Json.Bytes(derived).Length;
            var retained = Directory.EnumerateFiles(store.Root, "media-*.bin").Sum(p=>new FileInfo(p).Length);
            if (retained + size > 128L*1024*1024 || new DriveInfo(Path.GetPathRoot(store.Root)!).AvailableFreeSpace - size <= DurableQueue.DiskReserveBytes)
            {
                chosen.source.Issue = "MEDIA_STORAGE_PENDING"; nextMediaSend = DateTimeOffset.UtcNow.AddMinutes(5); return;
            }
            store.Write(cacheName,derived);
        }
        if (!networkOnline || DateTimeOffset.UtcNow < nextMediaSend) return;
        var rows = derived.Rows.Take(200).Select(row => new {
            location = row.Location, fields = row.Fields.Take(96).ToDictionary(p => p.Key,p => p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() : p.Value.GetRawText()),
            lineage = row.Lineage.Take(96).ToDictionary(p=>p.Key,p=>p.Value)
        }).ToList();
        var issues = derived.Issues.Take(8).ToList();
        if (derived.Rows.Count > rows.Count) issues.Add("Only the first 200 derived regions are included online.");
        object Body() => new { scopeDigest=grant.ScopeDigest,sourceId=chosen.source.Id,generation=chosen.source.Generation,
            observationId=capture.GetProperty("observationId"),originalSha256=entry.Digest,readerVersion=derived.ReaderVersion,
            format=derived.Format,rows,issues };
        while (rows.Count > 0 && Json.Bytes(Body()).Length > 960_000) rows.RemoveRange(rows.Count/2, rows.Count - rows.Count/2);
        try
        {
            var receipt = await api.Request("POST",WorkspaceApi+"/derivatives",Body(),state.Token,entry.CommitKey,ct);
            if (Optional(receipt,"originalSha256")?.GetString() != entry.Digest)
                throw new ConnectException("DERIVATIVE_RECEIPT_INVALID","The derived text receipt does not match its original.");
            chosen.source.MediaJobs.Remove(entry.Id);
            // The checked server receipt is durable; the encrypted source remains
            // in the original spool. This temporary replay cache is reproducible.
            try { File.Delete(Path.Combine(store.Root,cacheName)); } catch (IOException) { }
        }
        catch (Exception error) when (error is ApiException or ConnectException or HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            chosen.source.Issue = error is ApiException a ? a.Code : "MEDIA_SYNC_PENDING";
            chosen.source.MediaJobs.Remove(entry.Id);
            chosen.source.MediaJobs.Add(entry.Id);
            nextMediaSend = DateTimeOffset.UtcNow.AddSeconds(60);
        }
    }
}

