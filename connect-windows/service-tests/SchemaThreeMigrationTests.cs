using System.Text.Json;
using Microsoft.Data.Sqlite;
using PackProof.Connect;
using Xunit;
public sealed class SchemaThreeMigrationTests:IDisposable
{
    private readonly string root=Path.Combine(Path.GetTempPath(),"packproof-schema-three-"+Guid.NewGuid().ToString("N"));
    private sealed class PlainProtector:ISecretProtector{public byte[] Protect(byte[] b)=>b;public byte[] Unprotect(byte[] b)=>b;}
    private ProtectedStore Store(){var store=new ProtectedStore(root,new PlainProtector());store.Initialize();return store;}
    [Fact]public void Upgrade_from_queue_two_changes_only_the_marker_and_preserves_pending_and_completed_permit_payloads()
    {
        var store=Store();QueueEntry pending,completed;byte[] pendingBytes,completedBytes;JsonElement pendingBody=Json.Element(new{schema="packproof.typed-source-batch/v2",identityPolicy=new{schema="packproof.source-identity-policy/v1",eventKey=new{kind="composite",fields=new[]{"orderId","orderLineId","property"}},revision=new{kind="source_as_of"}},original=new{content="Order,Line,Qty\n001,004,9\n"}});
        using(var queue=new DurableQueue(store))
        {
            pending=queue.StageRequest("Order,Line,Qty\n001,004,9\n"u8.ToArray(),"pending.csv",pendingBody,"original-credential","original-config",true,new("source-a","packproof.order-lines/v1",4));
            completed=queue.StageRequest("Order,Line,Qty\n001,005,6\n"u8.ToArray(),"completed.csv",pendingBody,"original-credential","original-config",true,new("source-b","packproof.order-lines/v1",7));var payload=queue.Payload(completed);payload.Receipt=Json.Element(new{id="batch-completed",state="succeeded",original=new{sha256=completed.Digest},rowCount=1,counts=new{processing=0,acceptedLinked=1,acceptedUnlinked=0,duplicate=0,conflict=0,quarantined=0,rejected=0},rows=new[]{new{index=0,status="accepted_linked",raw=new{unmapped="original"},normalized=new{sourceEventId="row-b"}}}});queue.Save(completed,payload,"complete","batch-completed");completed=queue.Find(completed.Id)!;queue.CompactApprovedTyped(completed,"reviewed-command","reviewed-hash",DateTimeOffset.Parse("2026-11-14T12:00:00Z"),"pending-ack-permit");
        }
        pendingBytes=File.ReadAllBytes(Path.Combine(root,"spool",pending.PayloadPath));completedBytes=File.ReadAllBytes(Path.Combine(root,"spool",completed.PayloadPath));
        using(var old=new SqliteConnection($"Data Source={Path.Combine(root,"queue.sqlite")}")){old.Open();using var c=old.CreateCommand();c.CommandText="UPDATE meta SET version=2; PRAGMA user_version=2;";c.ExecuteNonQuery();}
        using(var upgraded=new DurableQueue(store))
        {
            Assert.Equal(pending,upgraded.Find(pending.Id));Assert.Equal(completed,upgraded.Find(completed.Id));var kept=upgraded.Payload(pending);Assert.Equal(Json.Bytes(pendingBody),kept.PreviewWireBody);Assert.Equal("original-credential",upgraded.Find(pending.Id)!.CredentialGeneration);Assert.Equal(4,upgraded.Find(pending.Id)!.GrantRevision);Assert.Equal("pending-ack-permit",upgraded.Payload(completed).CompactionPermitId);Assert.True(upgraded.Payload(completed).OriginalCompacted);Assert.Equal("",upgraded.Payload(completed).Csv);Assert.Equal("batch-completed",upgraded.Payload(completed).Receipt!.Value.GetProperty("id").GetString());
        }
        Assert.Equal(pendingBytes,File.ReadAllBytes(Path.Combine(root,"spool",pending.PayloadPath)));Assert.Equal(completedBytes,File.ReadAllBytes(Path.Combine(root,"spool",completed.PayloadPath)));
        using var marked=new SqliteConnection($"Data Source={Path.Combine(root,"queue.sqlite")}");marked.Open();using var marker=marked.CreateCommand();marker.CommandText="PRAGMA user_version";Assert.Equal(3,Convert.ToInt32(marker.ExecuteScalar()));marker.CommandText="SELECT version FROM meta";Assert.Equal(3,Convert.ToInt32(marker.ExecuteScalar()));
    }
    [Fact]public void Protected_state_two_upgrades_to_three_without_reassigning_credentials_sources_or_grants()
    {
        var store=Store();var config=Json.Element(new{batchSchema="packproof.typed-source-batch/v2",identityPolicy=new{schema="packproof.source-identity-policy/v1",eventKey=new{kind="column"},revision=new{kind="immutable_event"}}});
        var original=new LocalState{StateVersion=2,Token="preserved-credential",InstallationId="install-a",SourceSubscriptions=[new(){Id="source-a",SourceProfile="packproof.operational-observations/v2",ApprovedConfiguration=config,ConfigurationRevision=4,GrantRevision=8,ConfigurationSha256="exact-config-sha",SetupQueueId="saved-queue-id",CursorFileName="00009.csv"}]};store.Write("state.bin",original);
        var host=new HostConfiguration("staging","https://api.packproof.test","https://app.packproof.test","S-1-5-32-545");using(var runtime=new AgentRuntime(host,store,new PackProofClient(host),store.Read<LocalState>("state.bin")!)){}
        var migrated=store.Read<LocalState>("state.bin")!;Assert.Equal(3,migrated.StateVersion);Assert.Equal("preserved-credential",migrated.Token);Assert.Equal("install-a",migrated.InstallationId);var kept=Assert.Single(migrated.SourceSubscriptions,s=>s.Id=="source-a");Assert.Equal(4,kept.ConfigurationRevision);Assert.Equal(8,kept.GrantRevision);Assert.Equal("saved-queue-id",kept.SetupQueueId);Assert.Equal("00009.csv",kept.CursorFileName);Assert.Equal(config.GetRawText(),kept.ApprovedConfiguration!.Value.GetRawText());
        migrated.StateVersion=4;Assert.Throws<ConnectException>(()=>SourceStateMigration.Validate(migrated));
    }
    public void Dispose(){Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();if(Directory.Exists(root))Directory.Delete(root,true);}
}
