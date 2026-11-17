using System.Security.Cryptography;
using System.Text.Json;
using PackProof.Connect;
using Xunit;

public sealed class SourceCompactionTests:IDisposable
{
    private readonly string root=Path.Combine(Path.GetTempPath(),"packproof-compaction-"+Guid.NewGuid().ToString("N"));
    private sealed class PlainProtector:ISecretProtector{public byte[] Protect(byte[] b)=>b;public byte[] Unprotect(byte[] b)=>b;}
    private ProtectedStore Store(){var store=new ProtectedStore(root,new PlainProtector());store.Initialize();return store;}
    private static readonly DateTimeOffset Now=DateTimeOffset.Parse("2026-11-14T19:00:00Z");
    private static SourceSubscriptionState Source()=>new(){Id="source-a",SourceProfile="packproof.order-lines/v1",ConfigurationRevision=2,GrantRevision=4,ConfigurationSha256="config-sha",CapabilityApproved=true,ServerState="active",ServerView=Json.Element(new{organizationId="org-a",environment="sandbox",principalId="principal-a",installationId="install-a",connectionId="connection-a",locationId="site-a",operatorMembershipId="operator-a",capabilities=new{disposition=true}})};
    private static QueueEntry Entry(SourceSubscriptionState s)=>new("queue-a",new string('a',64),"complete","preview-key","commit-key","credential-a",s.QueueConfigurationIdentity("install-a"),"batch-a",0,Now,null,"payload.bin",s.Id,s.SourceProfile,s.GrantRevision);
    private static JsonElement Signed(Dictionary<string,object?> body)
    {
        var copy=new Dictionary<string,object?>(body);copy["commandSha256"]=Convert.ToHexStringLower(SHA256.HashData(TypedSourceSemantics.CanonicalBytes(Json.Element(body))));return Json.Element(copy);
    }
    private static Dictionary<string,object?> Command()=>new(){{"schema","packproof.collector-compaction-command/v1"},{"id","command-a"},{"requestId","request-a"},{"batchId","batch-a"},{"organizationId","org-a"},{"environment","sandbox"},{"principalId","principal-a"},{"installationId","install-a"},{"connectionId","connection-a"},{"locationId","site-a"},{"operatorMembershipId","operator-a"},{"subscriptionId","source-a"},{"configurationRevision",2},{"grantRevision",4},{"receiptGrantRevision",4},{"originalSha256",new string('a',64)},{"policyEventId","policy-event-a"},{"policyVersion","policy-v2"},{"retainUntil","2026-11-14T18:00:00Z"},{"compactAfterAcknowledgement",true},{"expiresAt","2026-11-15T19:00:00Z"}};
    [Fact]public void Compaction_binds_every_current_scope_and_explicit_server_retention_boundary()
    {
        var source=Source();var entry=Entry(source);bool Match(JsonElement c,QueueEntry? e=null,DateTimeOffset? now=null)=>AgentRuntime.CompactionCommandMatches(c,source,e??entry,"install-a","sandbox","credential-a",now??Now);
        Assert.True(Match(Signed(Command())));
        foreach(var field in new[]{"organizationId","environment","principalId","installationId","connectionId","locationId","operatorMembershipId","subscriptionId","batchId","originalSha256","schema"}){var command=Command();command[field]="wrong";Assert.False(Match(Signed(command)));}
        foreach(var field in new[]{"configurationRevision","grantRevision","receiptGrantRevision"}){var command=Command();command[field]=99;Assert.False(Match(Signed(command)));}
        var tampered=Command();tampered["commandSha256"]=new string('0',64);Assert.False(Match(Json.Element(tampered)));
        Assert.False(Match(Signed(Command()),entry with{State="server_processing"}));Assert.False(Match(Signed(Command()),entry with{CredentialGeneration="old-credential"}));Assert.False(Match(Signed(Command()),entry with{ConfigDigest="old-config"}));Assert.False(Match(Signed(Command()),entry with{GrantRevision=3}));
        Assert.False(Match(Signed(Command()),now:Now.AddHours(-2)));Assert.False(Match(Signed(Command()),now:Now.AddDays(1)));
        source.ServerState="revoked";Assert.False(Match(Signed(Command())));
    }
    [Fact]public void Activated_first_receipt_compacts_under_current_erasure_grant_without_reassigning_capture_or_pending_work()
    {
        var source=Source();source.GrantRevision=2;source.ServerState="approved";
        using var queue=new DurableQueue(Store());
        var staged=queue.StageRequest("Order,Qty\n001,1\n"u8.ToArray(),"first.csv",Json.Element(new{original=new{content="Order,Qty\n001,1\n"}}),"credential-a",source.QueueConfigurationIdentity("install-a"),true,new(source.Id,source.SourceProfile,source.GrantRevision));
        var payload=queue.Payload(staged);payload.Receipt=Receipt(staged.Digest);queue.Save(staged,payload,"complete","batch-a");var completed=queue.Find(staged.Id)!;
        // Browser activation changes the recurring grant, not the first receipt's
        // captured ownership or immutable queued request identity.
        source.GrantRevision=3;source.ServerState="active";
        var body=Command();body["grantRevision"]=3;body["receiptGrantRevision"]=2;body["originalSha256"]=completed.Digest;
        bool Match(Dictionary<string,object?> command,QueueEntry? entry=null)=>AgentRuntime.CompactionCommandMatches(Signed(command),source,entry??completed,"install-a","sandbox","credential-a",Now);
        Assert.True(Match(body));Assert.NotEqual(completed.ConfigDigest,source.QueueConfigurationIdentity("install-a"));
        Assert.False(Match(body,completed with{State="staged"}));Assert.False(Match(body,completed with{State="server_processing"}));
        var wrongCapture=new Dictionary<string,object?>(body){["receiptGrantRevision"]=3};Assert.False(Match(wrongCapture));var staleErasure=new Dictionary<string,object?>(body){["grantRevision"]=2};Assert.False(Match(staleErasure));
        Assert.Equal("compacted",queue.CompactApprovedTyped(completed,"command-a",Signed(body).GetProperty("commandSha256").GetString()!,Now,"online-permit-a"));
        Assert.Equal(completed,queue.Find(completed.Id));Assert.Equal(2,queue.Find(completed.Id)!.GrantRevision);Assert.True(queue.Payload(completed).OriginalCompacted);
        source.ConfigurationSha256="another-config";Assert.False(Match(body));
    }
    [Fact]public void Online_preservation_permit_must_be_exact_current_and_inside_its_short_window()
    {
        var entry=Entry(Source());var command=Signed(Command());
        Dictionary<string,object?> Permit()=>new(){{"id","permit-a"},{"commandId","command-a"},{"commandSha256",command.GetProperty("commandSha256").GetString()},{"batchId",entry.ImportId},{"originalSha256",entry.Digest},{"issuedAt",Now.ToString("O")},{"expiresAt",Now.AddSeconds(30).ToString("O")},{"serverTime",Now.ToString("O")}};
        Assert.Equal(Now,AgentRuntime.CompactionPermitTime(Json.Element(Permit()),command,entry,Now));
        foreach(var field in new[]{"commandId","commandSha256","batchId","originalSha256"}){var permit=Permit();permit[field]="different";Assert.Throws<ConnectException>(()=>AgentRuntime.CompactionPermitTime(Json.Element(permit),command,entry,Now));}
        foreach(var offset in new[]{-3,30,60})Assert.Throws<ConnectException>(()=>AgentRuntime.CompactionPermitTime(Json.Element(Permit()),command,entry,Now.AddSeconds(offset)));
        var tooLong=Permit();tooLong["expiresAt"]=Now.AddMinutes(1).ToString("O");Assert.Throws<ConnectException>(()=>AgentRuntime.CompactionPermitTime(Json.Element(tooLong),command,entry,Now));
    }
    private static JsonElement Receipt(string digest)=>Json.Element(new{id="batch-a",state="succeeded",subscriptionId="source-a",configurationRevision=2,original=new{sha256=digest},rowCount=1,counts=new{processing=0,acceptedLinked=1,acceptedUnlinked=0,duplicate=0,conflict=0,quarantined=0,rejected=0},rows=new[]{new{index=0,status="accepted_linked",raw=new{privateUnmapped="original-only"},normalized=new{sourceEventId="row-a"}}}});
    [Fact]public void Exact_completed_compaction_keeps_keys_digest_and_accounting_and_retries_after_restart()
    {
        var store=Store();string id;string previewKey;string commitKey;string digest;
        using(var queue=new DurableQueue(store))
        {
            var staged=queue.StageRequest("Order,Qty\n001,1\n"u8.ToArray(),"orders.csv",Json.Element(new{original=new{content="Order,Qty\n001,1\n"}}),"credential-a","config-a",true,new("source-a","packproof.order-lines/v1",4));id=staged.Id;previewKey=staged.PreviewKey;commitKey=staged.CommitKey;digest=staged.Digest;
            Assert.Throws<ConnectException>(()=>queue.CompactApprovedTyped(staged,"command-a","command-hash",Now,"permit-a"));Assert.NotEmpty(queue.Payload(staged).Csv);
            var payload=queue.Payload(staged);payload.Receipt=Receipt(staged.Digest);queue.Save(staged,payload,"complete","batch-a");var entry=queue.Find(id)!;
            Assert.Equal("compacted",queue.CompactApprovedTyped(entry,"command-a","command-hash",Now,"permit-a"));
        }
        using(var reopened=new DurableQueue(store))
        {
            var entry=reopened.Find(id)!;var kept=reopened.Payload(entry);Assert.Equal("complete",entry.State);Assert.Equal(digest,entry.Digest);Assert.Equal(previewKey,entry.PreviewKey);Assert.Equal(commitKey,entry.CommitKey);Assert.Equal("credential-a",entry.CredentialGeneration);Assert.Equal("config-a",entry.ConfigDigest);Assert.Equal("",kept.Csv);Assert.Null(kept.PreviewWireBody);Assert.Equal("{}",kept.PreviewBody.GetRawText());Assert.True(kept.OriginalCompacted);Assert.Equal(Now,kept.CompactedAt);Assert.Equal("permit-a",kept.CompactionPermitId);AgentRuntime.ValidateTypedAccounting(kept.Receipt!.Value);Assert.False(kept.Receipt.Value.GetProperty("rows")[0].TryGetProperty("raw",out _));
            Assert.Equal("already_compacted",reopened.CompactApprovedTyped(entry,"command-a","command-hash",Now.AddMinutes(1),"permit-a"));Assert.Throws<ConnectException>(()=>reopened.CompactApprovedTyped(entry,"another-command","another-hash",Now,"permit-a"));
        }
    }
    [Fact]public void A_completed_flag_cannot_compact_an_unreconciled_or_different_original()
    {
        using var queue=new DurableQueue(Store());var entry=queue.StageRequest("retain"u8.ToArray(),"orders.csv",Json.Element(new{}),"credential-a","config-a",true,new("source-a","packproof.order-lines/v1",4));var payload=queue.Payload(entry);payload.Receipt=Receipt(new string('b',64));queue.Save(entry,payload,"complete","batch-a");entry=queue.Find(entry.Id)!;Assert.Throws<ConnectException>(()=>queue.CompactApprovedTyped(entry,"command-a","hash",Now,"permit-a"));Assert.Equal("retain",queue.Payload(entry).Csv);
        payload.Receipt=Receipt(entry.Digest);queue.Save(entry,payload,"server_processing");entry=queue.Find(entry.Id)!;Assert.Equal(0,queue.CompactCompleted(Now.AddDays(30)));Assert.False(queue.Payload(entry).OriginalCompacted);
    }
    public void Dispose(){Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();if(Directory.Exists(root))Directory.Delete(root,true);}
}
