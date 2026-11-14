using Microsoft.Data.Sqlite;
using System.Security.Cryptography;
using System.Text;
namespace PackProof.Connect;

public sealed record SourceQueueMetrics(int PendingCount,string? OldestPendingAt,int PendingAgeUnknownCount,long RetainedBytes,long OriginalBytesKnown,int OriginalBytesUnknownCount);
public sealed partial class DurableQueue
{
    internal QueueEntry? FindOriginalForSource(string digest,string configuration,QueueSourceIdentity source)
    {
        var entry=FindOriginal(digest,configuration);if(entry is not null)RequireSource(entry,source);return entry;
    }
    internal void PromoteLive(string id)
    {
        using var c=db.CreateCommand();c.CommandText="UPDATE queue_work SET live_requested=1 WHERE queue_id=$id";c.Parameters.AddWithValue("$id",id);c.ExecuteNonQuery();
    }
    internal void YieldRetry(QueueEntry entry)
    {
        using var c=db.CreateCommand();c.CommandText="UPDATE queue SET next_attempt_at=$next WHERE id=$id";c.Parameters.AddWithValue("$next",DateTimeOffset.UtcNow.AddSeconds(30).ToString("O"));c.Parameters.AddWithValue("$id",entry.Id);c.ExecuteNonQuery();
    }
    internal QueueEntry? NextDueLane(string sourceId,string generation,string configuration,DateTimeOffset now,bool history)
    {
        using var c=db.CreateCommand();var qualified=string.Join(',',Columns.Split(',').Select(n=>"q."+n));
        c.CommandText=$"SELECT {qualified} FROM queue q LEFT JOIN queue_work w ON w.queue_id=q.id WHERE q.source_id=$source AND q.credential_generation=$generation AND q.config_digest=$config AND q.state NOT IN ('complete','partial','action_needed','awaiting_review') AND q.next_attempt_at<=$now AND "+(history?"w.origin_lane='backfill' AND w.live_requested=0":"(COALESCE(w.origin_lane,'live')='live' OR w.live_requested=1)")+" ORDER BY q.next_attempt_at,q.rowid LIMIT 1";
        c.Parameters.AddWithValue("$source",sourceId);c.Parameters.AddWithValue("$generation",generation);c.Parameters.AddWithValue("$config",configuration);c.Parameters.AddWithValue("$now",now.ToString("O"));return ReadEntries(c).FirstOrDefault();
    }
    internal void LinkBackfillItem(string jobId,string itemId,string manifestSha256,string queueId)
    {
        using var c=db.CreateCommand();c.CommandText="SELECT queue_id,manifest_sha256 FROM queue_backfill_items WHERE job_id=$job AND item_id=$item";c.Parameters.AddWithValue("$job",jobId);c.Parameters.AddWithValue("$item",itemId);
        using(var r=c.ExecuteReader())if(r.Read()&&((!r.IsDBNull(0)&&r.GetString(0)!=queueId)||r.GetString(1)!=manifestSha256))throw new ConnectException("BACKFILL_MANIFEST_CHANGED","The historical job item already identifies another retained original.");
        c.CommandText="INSERT INTO queue_backfill_items(job_id,item_id,manifest_sha256,queue_id) VALUES($job,$item,$manifest,$queue) ON CONFLICT(job_id,item_id) DO UPDATE SET queue_id=excluded.queue_id,error_code=NULL";c.Parameters.AddWithValue("$manifest",manifestSha256);c.Parameters.AddWithValue("$queue",queueId);c.ExecuteNonQuery();
    }
    internal string? BackfillQueueId(string jobId,string itemId)
    {
        using var c=db.CreateCommand();c.CommandText="SELECT queue_id FROM queue_backfill_items WHERE job_id=$job AND item_id=$item";c.Parameters.AddWithValue("$job",jobId);c.Parameters.AddWithValue("$item",itemId);return c.ExecuteScalar() as string;
    }
    internal string? BackfillItemError(string jobId,string itemId)
    {
        using var c=db.CreateCommand();c.CommandText="SELECT error_code FROM queue_backfill_items WHERE job_id=$job AND item_id=$item";c.Parameters.AddWithValue("$job",jobId);c.Parameters.AddWithValue("$item",itemId);return c.ExecuteScalar() as string;
    }
    internal void BackfillFailure(string jobId,string itemId,string manifestSha256,string error)
    {
        using var c=db.CreateCommand();c.CommandText="INSERT INTO queue_backfill_items(job_id,item_id,manifest_sha256,error_code) VALUES($job,$item,$manifest,$error) ON CONFLICT(job_id,item_id) DO UPDATE SET error_code=excluded.error_code";c.Parameters.AddWithValue("$job",jobId);c.Parameters.AddWithValue("$item",itemId);c.Parameters.AddWithValue("$manifest",manifestSha256);c.Parameters.AddWithValue("$error",error);c.ExecuteNonQuery();
    }
    internal void RetryBackfill(string jobId)
    {
        using var c=db.CreateCommand();c.CommandText="UPDATE queue_backfill_items SET error_code=NULL WHERE job_id=$job";c.Parameters.AddWithValue("$job",jobId);c.ExecuteNonQuery();
        c.CommandText="UPDATE queue SET state=CASE WHEN import_id IS NULL THEN 'staged' ELSE 'server_processing' END,error_code=NULL,next_attempt_at=$now WHERE id IN(SELECT queue_id FROM queue_backfill_items WHERE job_id=$job) AND state='action_needed' AND error_code IN ('SOURCE_BACKFILL_NOT_APPROVED','SOURCE_BACKFILL_APPROVAL_EXPIRED')";c.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));c.ExecuteNonQuery();
    }
    internal SourceQueueMetrics Metrics(string sourceId)
    {
        var entries=Entries().Where(e=>e.SourceId==sourceId).ToArray();var pending=0;var unknownAge=0;DateTimeOffset? oldest=null;long retained=0,originalKnown=0;var originalUnknown=0;
        foreach(var e in entries)
        {
            retained+=new FileInfo(Path.Combine(spoolRoot,e.PayloadPath)).Length;
            using var c=db.CreateCommand();c.CommandText="SELECT created_at,original_byte_size FROM queue_work WHERE queue_id=$id";c.Parameters.AddWithValue("$id",e.Id);string? created=null;long? bytes=null;
            using(var r=c.ExecuteReader())if(r.Read()){created=r.IsDBNull(0)?null:r.GetString(0);bytes=r.IsDBNull(1)?null:r.GetInt64(1);}
            if(e.State!="complete"){pending++;if(created is null)unknownAge++;else{var at=DateTimeOffset.Parse(created);if(oldest is null||at<oldest)oldest=at;}}
            // Old schema rows have no capture timestamp. Original size may be
            // recovered from verified retained bytes, never from migration time.
            if(bytes is null)try
            {
                var payload=Payload(e);
                if(!payload.OriginalCompacted){var raw=payload.QuarantinedOriginalBytes??Encoding.UTF8.GetBytes(payload.Csv);if(Convert.ToHexStringLower(SHA256.HashData(raw))==e.Digest)bytes=raw.LongLength;}
                else if(payload.Receipt is { } receipt&&receipt.TryGetProperty("original",out var original)&&original.GetProperty("sha256").GetString()==e.Digest&&original.TryGetProperty("byteSize",out var size)&&size.TryGetInt64(out var count)&&count>0)bytes=count;
                if(bytes is not null){c.CommandText="UPDATE queue_work SET original_byte_size=$bytes WHERE queue_id=$id";c.Parameters.AddWithValue("$bytes",bytes.Value);c.ExecuteNonQuery();}
            }
            catch(Exception error)when(error is ConnectException or KeyNotFoundException or InvalidOperationException or FormatException){bytes=null;}
            if(bytes is { } known)originalKnown+=known;else originalUnknown++;
        }
        return new(pending,oldest?.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),unknownAge,retained,originalKnown,originalUnknown);
    }
}
