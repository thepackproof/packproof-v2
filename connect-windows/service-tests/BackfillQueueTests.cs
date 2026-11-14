using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;
using PackProof.Connect;
using Xunit;
public sealed class BackfillQueueTests:IDisposable
{
    private readonly string root=Path.Combine(Path.GetTempPath(),"packproof-history-queue-"+Guid.NewGuid().ToString("N"));
    private sealed class PlainProtector:ISecretProtector{public byte[] Protect(byte[] b)=>b;public byte[] Unprotect(byte[] b)=>b;}
    private ProtectedStore Store(){var s=new ProtectedStore(root,new PlainProtector());s.Initialize();return s;}
    private static readonly QueueSourceIdentity Source=new("source-a","packproof.order-lines/v1",3);
    [Fact]public void History_and_live_overlap_share_one_original_and_immutable_wire_keys_while_live_gets_priority()
    {
        using var queue=new DurableQueue(Store());var bytes="immutable original"u8.ToArray();var request=Json.Element(new{collectionContext=new{kind="historical_backfill",jobId="job-a",itemId="item-a"}});
        var history=queue.StageRequest(bytes,"same.csv",request,"credential","config",true,Source,history:true);var originalWire=queue.Payload(history).PreviewWireBody;
        Assert.Null(queue.NextDueLane(Source.SourceId,"credential","config",DateTimeOffset.UtcNow.AddSeconds(1),history:false));Assert.Equal(history.Id,queue.NextDueLane(Source.SourceId,"credential","config",DateTimeOffset.UtcNow.AddSeconds(1),history:true)!.Id);
        queue.LinkBackfillItem("job-a","item-a","manifest-a",history.Id);queue.LinkBackfillItem("job-b","item-b","manifest-b",history.Id);
        var live=queue.StageRequest(bytes,"same.csv",Json.Element(new{different="must not replace saved request"}),"credential","config",true,Source);
        Assert.Equal(history,live);Assert.Single(queue.Entries());Assert.Equal(originalWire,queue.Payload(live).PreviewWireBody);Assert.Equal(history.PreviewKey,live.PreviewKey);Assert.Equal(history.CommitKey,live.CommitKey);Assert.Equal(history.Id,queue.BackfillQueueId("job-b","item-b"));Assert.Equal(history.Id,queue.NextDueLane(Source.SourceId,"credential","config",DateTimeOffset.UtcNow.AddSeconds(1),history:false)!.Id);Assert.Null(queue.NextDueLane(Source.SourceId,"credential","config",DateTimeOffset.UtcNow.AddSeconds(1),history:true));
    }
    [Fact]public void History_reserves_original_slots_for_live_without_purging_pending_work()
    {
        using var queue=new DurableQueue(Store(),originalFileLimit:2);var old=queue.StageRequest("a"u8.ToArray(),"a.csv",Json.Element(new{}),"credential","config",true,Source);
        Assert.Equal("BACKFILL_LIVE_RESERVE",Assert.Throws<ConnectException>(()=>queue.StageRequest("b"u8.ToArray(),"b.csv",Json.Element(new{}),"credential","config",true,Source,history:true)).Code);
        queue.StageRequest("c"u8.ToArray(),"c.csv",Json.Element(new{}),"credential","config",true,Source);Assert.Equal(2,queue.Entries().Count);Assert.Equal("a",queue.Payload(old).Csv);
    }
    [Fact]public void History_reserves_encrypted_bytes_for_live_and_counts_orphans_without_deleting_them()
    {
        using var queue=new DurableQueue(Store());var orphan=Path.Combine(root,"spool","retained-orphan.bin");var length=DurableQueue.MaxSpoolBytes-256L*1024*1024;using(var f=new FileStream(orphan,FileMode.CreateNew))f.SetLength(length);
        Assert.Equal("BACKFILL_LIVE_RESERVE",Assert.Throws<ConnectException>(()=>queue.StageRequest("history"u8.ToArray(),"old.csv",Json.Element(new{}),"credential","config",true,Source,history:true)).Code);
        queue.StageRequest("live"u8.ToArray(),"live.csv",Json.Element(new{}),"credential","config",true,Source);Assert.Single(queue.Entries());Assert.Equal(length,new FileInfo(orphan).Length);Assert.Equal(1,queue.OrphanCount);
    }
    [Fact]public void Exhausted_shared_capacity_keeps_history_waiting_without_a_shared_collection_failure()
    {
        using var queue=new DurableQueue(Store(),originalFileLimit:1);queue.StageRequest("retained"u8.ToArray(),"retained.csv",Json.Element(new{}),"credential","config",true,Source);
        Assert.Equal("BACKFILL_LIVE_RESERVE",Assert.Throws<ConnectException>(()=>queue.StageRequest("history"u8.ToArray(),"old.csv",Json.Element(new{}),"credential","config",true,Source,history:true)).Code);
        Assert.Equal("SPOOL_CAPACITY_REACHED",Assert.Throws<ConnectException>(()=>queue.StageRequest("live"u8.ToArray(),"live.csv",Json.Element(new{}),"credential","config",true,Source)).Code);Assert.Single(queue.Entries());
    }
    [Fact]public void Schema_three_upgrade_keeps_unknown_capture_age_and_exact_bytes_then_reports_real_retained_size()
    {
        var store=Store();QueueEntry old;byte[] encrypted;
        using(var queue=new DurableQueue(store)){old=queue.StageRequest(Encoding.UTF8.GetBytes("\ufeffOrder,Qty\n001,1\n"),"old.csv",Json.Element(new{}),"credential","config",true,Source);}
        encrypted=File.ReadAllBytes(Path.Combine(root,"spool",old.PayloadPath));
        using(var connection=new SqliteConnection($"Data Source={Path.Combine(root,"queue.sqlite")}")){connection.Open();using var c=connection.CreateCommand();c.CommandText="DROP TABLE queue_backfill_items;DROP TABLE queue_work;UPDATE meta SET version=3;PRAGMA user_version=3;";c.ExecuteNonQuery();}
        using var upgraded=new DurableQueue(store);var before=upgraded.Metrics(Source.SourceId);Assert.Equal(1,before.PendingCount);Assert.Null(before.OldestPendingAt);Assert.Equal(1,before.PendingAgeUnknownCount);Assert.Equal(encrypted.LongLength,before.RetainedBytes);Assert.Equal(Encoding.UTF8.GetByteCount("\ufeffOrder,Qty\n001,1\n"),before.OriginalBytesKnown);Assert.Equal(0,before.OriginalBytesUnknownCount);Assert.Equal(old,upgraded.Find(old.Id));Assert.Equal(encrypted,File.ReadAllBytes(Path.Combine(root,"spool",old.PayloadPath)));
        upgraded.StageRequest("new"u8.ToArray(),"new.csv",Json.Element(new{}),"credential","config",true,Source);var after=upgraded.Metrics(Source.SourceId);Assert.Equal(2,after.PendingCount);Assert.Equal(1,after.PendingAgeUnknownCount);Assert.NotNull(after.OldestPendingAt);Assert.Equal(Directory.EnumerateFiles(Path.Combine(root,"spool")).Sum(p=>new FileInfo(p).Length),after.RetainedBytes);
    }
    [Fact]public void Permitted_completed_typed_compaction_frees_an_original_slot_but_keeps_summary_bytes_and_receipt()
    {
        using var queue=new DurableQueue(Store(),originalFileLimit:1);var entry=queue.StageRequest("first"u8.ToArray(),"first.csv",Json.Element(new{}),"credential","config",true,Source);var payload=queue.Payload(entry);payload.Receipt=Json.Element(new{id="batch-a",state="succeeded",original=new{sha256=entry.Digest},rowCount=1,counts=new{processing=0,acceptedLinked=1,acceptedUnlinked=0,duplicate=0,conflict=0,quarantined=0,rejected=0},rows=new[]{new{index=0,status="accepted_linked"}}});queue.Save(entry,payload,"complete","batch-a");entry=queue.Find(entry.Id)!;
        queue.CompactApprovedTyped(entry,"approved-command","command-sha",DateTimeOffset.UtcNow,"online-permit");queue.StageRequest("next"u8.ToArray(),"next.csv",Json.Element(new{}),"credential","config",true,Source);Assert.Equal(2,queue.Entries().Count);Assert.True(queue.Payload(entry).OriginalCompacted);Assert.Equal(entry,queue.Find(entry.Id));Assert.Equal("batch-a",queue.Payload(entry).Receipt!.Value.GetProperty("id").GetString());Assert.True(queue.Metrics(Source.SourceId).RetainedBytes>0);
    }
    public void Dispose(){SqliteConnection.ClearAllPools();if(Directory.Exists(root))Directory.Delete(root,true);}
}
