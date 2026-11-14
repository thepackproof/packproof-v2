using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PackProof.Connect;
using Xunit;

public sealed class SourceSubscriptionTests:IDisposable
{
    private readonly string root=Path.Combine(Path.GetTempPath(),"packproof-sources-"+Guid.NewGuid().ToString("N"));
    private sealed class PlainProtector:ISecretProtector{public byte[] Protect(byte[] b)=>b;public byte[] Unprotect(byte[] b)=>b;}
    private ProtectedStore Store(){var store=new ProtectedStore(root,new PlainProtector());store.Initialize();return store;}
    [Fact]public void Upgrade_keeps_legacy_original_keys_receipts_and_credential_ownership()
    {
        var store=Store();string id,key,commit;byte[] original=Encoding.UTF8.GetBytes("Reference,Description,Quantity\n0001,Fixture,1\n");
        using(var queue=new DurableQueue(store)){var entry=queue.Stage(original,"source.csv",new(Json.Element(new{integrationAccountId="integration",operatorMembershipId="member",sourceName="source",mapping=new{shipmentReference="Reference",itemTitle="Description",quantity="Quantity"},timeZone="UTC"})),"old-credential","old-config",true);id=entry.Id;key=entry.PreviewKey;commit=entry.CommitKey;}
        // Restore an actual v1 table shape around the untouched encrypted spool,
        // then open with the new reader to exercise additive migration.
        using(var db=new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={Path.Combine(root,"queue.sqlite")}")){db.Open();using var c=db.CreateCommand();c.CommandText="DROP INDEX queue_source_due; DROP INDEX queue_source_page; ALTER TABLE queue DROP COLUMN source_id; ALTER TABLE queue DROP COLUMN source_profile; ALTER TABLE queue DROP COLUMN grant_revision; UPDATE meta SET version=1; PRAGMA user_version=1;";c.ExecuteNonQuery();}
        using var reopened=new DurableQueue(store);var kept=reopened.Find(id)!;Assert.Equal(key,kept.PreviewKey);Assert.Equal(commit,kept.CommitKey);Assert.Equal("old-credential",kept.CredentialGeneration);Assert.Equal("old-config",kept.ConfigDigest);Assert.Equal("legacy",kept.SourceId);Assert.Equal(0,kept.GrantRevision);Assert.Equal(original,Encoding.UTF8.GetBytes(reopened.Payload(kept).Csv));
    }
    [Fact]public void Protected_state_migration_does_not_reinterpret_legacy_approval_as_typed_authority()
    {
        var state=new LocalState{Token="keep-secret",Folder="C:\\Exports",FolderDigest="same-folder",ScanCursorFileName="00009.csv",LocalPaused=false,ServerConfig=Json.Element(new{state="active",configSha256="old-digest",configRevision=4,config=new{mapping=new{shipmentReference="Reference"}}})};
        SourceStateMigration.SynchronizeLegacy(state);var source=Assert.Single(state.SourceSubscriptions);Assert.Equal(2,state.StateVersion);Assert.Equal("legacy",source.Id);Assert.False(source.CapabilityApproved);Assert.Equal("00009.csv",source.CursorFileName);Assert.Equal("old-digest",source.ConfigurationSha256);Assert.Equal("keep-secret",state.Token);Assert.False(source.LocalPaused);
        state.StateVersion=3;Assert.Equal("LOCAL_STATE_UNSUPPORTED",Assert.Throws<ConnectException>(()=>SourceStateMigration.Validate(state)).Code);
    }
    [Fact]public void Source_paging_due_work_and_counts_are_isolated_and_keep_old_authority()
    {
        using var queue=new DurableQueue(Store());var one=queue.StageRequest("a"u8.ToArray(),"a.csv",Json.Element(new{original="a"}),"old-key","config-a",true,new("source-a","profile-a",2));
        queue.StageRequest("b"u8.ToArray(),"b.csv",Json.Element(new{original="b"}),"new-key","config-b",true,new("source-b","profile-b",4));
        Assert.Single(queue.Page("source-a"));Assert.Single(queue.Page("source-b"));Assert.Empty(queue.Page("source-a",generation:"new-key"));Assert.Null(queue.NextDue("source-a","new-key","config-a",DateTimeOffset.UtcNow.AddMinutes(1)));Assert.Equal(one.Id,queue.NextDue("source-a","old-key","config-a",DateTimeOffset.UtcNow.AddMinutes(1))!.Id);Assert.Equal(1,queue.Counts("source-b")["staged"]);
        Assert.Equal("QUEUE_AUTHORITY_CONFLICT",Assert.Throws<ConnectException>(()=>queue.StageRequest("a"u8.ToArray(),"renamed.csv",Json.Element(new{}),"new-key","config-a",true,new("source-b","profile-b",4))).Code);
    }
    [Fact]public async Task Schema_drift_pauses_one_source_and_fair_scheduler_continues_other_sources()
    {
        var sources=new[]{new SourceSubscriptionState{Id="a",CapabilityApproved=true,LocalPaused=false},new SourceSubscriptionState{Id="b",CapabilityApproved=true,LocalPaused=false},new SourceSubscriptionState{Id="c",CapabilityApproved=true,LocalPaused=false},new SourceSubscriptionState{Id="d",CapabilityApproved=true,LocalPaused=false}};
        var seen=new List<string>();var cursor=await SourceScheduler.Run(sources,null,(source,_)=>{seen.Add(source.Id);if(source.Id=="a")throw new ConnectException("MAPPING_NEEDS_REVIEW","Changed source");return Task.CompletedTask;},default);
        Assert.Equal(new[]{"a","b","c"},seen);Assert.True(sources[0].LocalPaused);Assert.False(sources[1].LocalPaused);Assert.Equal("d",SourceScheduler.Order(sources,cursor)[0].Id);
    }
    [Fact]public async Task A_source_specific_permission_denial_preserves_other_source_collection()
    {
        var sources=new[]{new SourceSubscriptionState{Id="a",CapabilityApproved=true,LocalPaused=false},new SourceSubscriptionState{Id="b",CapabilityApproved=true,LocalPaused=false}};var seen=new List<string>();
        await SourceScheduler.Run(sources,null,(source,_)=>{seen.Add(source.Id);if(source.Id=="a")throw new ApiException("SOURCE_AUTHORIZATION_REQUIRED",403);return Task.CompletedTask;},default);
        Assert.Equal(new[]{"a","b"},seen);Assert.True(sources[0].LocalPaused);Assert.False(sources[1].LocalPaused);
    }
    [Fact]public async Task Shared_storage_pressure_stops_all_remaining_source_admission()
    {
        var sources=new[]{new SourceSubscriptionState{Id="a",CapabilityApproved=true,LocalPaused=false},new SourceSubscriptionState{Id="b",CapabilityApproved=true,LocalPaused=false}};var seen=new List<string>();
        var error=await Assert.ThrowsAsync<ConnectException>(()=>SourceScheduler.Run(sources,null,(source,_)=>{seen.Add(source.Id);throw new ConnectException("SPOOL_CAPACITY_REACHED","Storage pressure");},default));Assert.Equal("SPOOL_CAPACITY_REACHED",error.Code);Assert.Equal(new[]{"a"},seen);
    }
    [Fact]public void Shared_CSV_fixtures_have_identical_local_and_hosted_normalization_and_business_hashes()
    {
        using var corpus=JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"source-contract-corpus.json")));var exercised=0;
        foreach(var fixture in corpus.RootElement.GetProperty("cases").EnumerateArray())
        {
            var input=fixture.GetProperty("input");if(input.GetProperty("original").GetProperty("mediaType").GetString()!="text/csv")continue;
            var local=TypedSourceSemantics.Preview(Encoding.UTF8.GetBytes(input.GetProperty("original").GetProperty("content").GetString()!),input);var expected=fixture.GetProperty("expected").GetProperty("rows").EnumerateArray().ToArray();Assert.Equal(expected.Length,local.Count);
            for(var i=0;i<local.Count;i++){Assert.Equal(expected[i].GetProperty("normalized").ValueKind!=JsonValueKind.Null,local[i].Valid);if(local[i].Valid){Assert.Equal(TypedSourceSemantics.CanonicalBytes(expected[i].GetProperty("normalized")),TypedSourceSemantics.CanonicalBytes(local[i].Normalized!.Value));Assert.Equal(expected[i].GetProperty("payloadSha256").GetString(),local[i].PayloadSha256);}}
            exercised++;
        }
        Assert.True(exercised>=2);
    }
    [Fact]public void Typed_receipt_accounting_accepts_explicit_unlinked_but_rejects_lost_or_duplicate_rows()
    {
        var receipt=Json.Element(new{rowCount=2,counts=new{processing=0,acceptedLinked=1,acceptedUnlinked=1,duplicate=0,conflict=0,quarantined=0,rejected=0},rows=new[]{new{index=0,status="accepted_linked"},new{index=1,status="accepted_unlinked"}}});AgentRuntime.ValidateTypedAccounting(receipt);
        var invalid=Json.Element(new{rowCount=3,counts=receipt.GetProperty("counts"),rows=receipt.GetProperty("rows")});Assert.Equal("TYPED_RECEIPT_ACCOUNTING_FAILED",Assert.Throws<ConnectException>(()=>AgentRuntime.ValidateTypedAccounting(invalid)).Code);
    }
    [Fact]public void Initial_case_verification_requires_stored_assertions_from_the_exact_authorized_batch()
    {
        var subject=new{ @namespace="source",type="shipment",externalId="S-0021"};var assertion=new{subjectReference=subject,property="status",value="loaded"};
        var receipt=Json.Element(new{caseIds=new[]{"case-a"},rows=new[]{new{rowNumber=2,status="accepted_linked",normalized=new{assertions=new[]{assertion}}}}});
        JsonElement Stored(string value)=>Json.Element(new{schema="packproof.typed-import-records/v1",batchId="batch-a",originalSha256="digest",rows=new[]{new{rowNumber=2,caseId="case-a",projectionRevision=1,observationId="observation-a",assertions=new[]{new{id="assertion-a",subjectReference=subject,property="status",value}}}}});
        Assert.Equal("case-a",AgentRuntime.ValidateTypedStoredRecords(receipt,Stored("loaded"),"batch-a","digest"));
        Assert.Equal("SOURCE_CASE_VERIFICATION_FAILED",Assert.Throws<ConnectException>(()=>AgentRuntime.ValidateTypedStoredRecords(receipt,Stored("different"),"batch-a","digest")).Code);
        Assert.Equal("SOURCE_CASE_VERIFICATION_FAILED",Assert.Throws<ConnectException>(()=>AgentRuntime.ValidateTypedStoredRecords(receipt,Stored("loaded"),"another-batch","digest")).Code);
    }
    private sealed class FakeSources(Dictionary<string,byte[]> files):ISourceAdapter
    {
        public IReadOnlyList<string> Inspect(SourceSubscriptionState source)=>[source.Id+".csv"];
        public CollectedSourceFile Read(SourceSubscriptionState source,string name)=>new(name,files[source.Id]);
        public void Dispose() { }
    }
    private sealed class Replies(Func<HttpRequestMessage,Task<HttpResponseMessage>> reply):HttpMessageHandler
    { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)=>reply(request); }
    [Theory][InlineData(false)][InlineData(true)]public async Task Runtime_collects_three_approved_feeds_without_UI_and_isolates_schema_drift(bool driftingMiddleSource)
    {
        using var corpus=JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"source-contract-corpus.json")));
        var input=corpus.RootElement.GetProperty("cases").EnumerateArray().First(f=>f.GetProperty("name").GetString()=="csv-loading").GetProperty("input");
        var content=input.GetProperty("original").GetProperty("content").GetString()!;
        var sources=new List<SourceSubscriptionState>();var files=new Dictionary<string,byte[]>();var views=new List<object>();
        foreach(var id in new[]{"source-a","source-b","source-c"})
        {
            var values=input.EnumerateObject().Where(p=>new[]{"sourceProfile","sourceNamespace","mappingVersion","mapping","constants"}.Contains(p.Name)).ToDictionary(p=>p.Name,p=>(object?)p.Value);
            values["transport"]="local_ntfs";values["displayName"]=id;values["folderDigest"]="protected-folder";values["offlineWindowHours"]=24;values["maxBytes"]=2097152;values["maxRows"]=1000;values["historyFrom"]="2026-01-01T00:00:00Z";values["historyTo"]=null;
            var config=Json.Element(values);var source=new SourceSubscriptionState{Id=id,SourceProfile=input.GetProperty("sourceProfile").GetString()!,Folder="fake-NTFS-test-seam",FolderDigest="protected-folder",ApprovedConfiguration=config,ConfigurationSha256=id+"-config",ConfigurationRevision=1,GrantRevision=2,CapabilityApproved=true,LocalPaused=false,ServerState="active"};sources.Add(source);
            views.Add(new{id,installationId="installation",connectionId=id,locationId="site-a",configurationRevision=1,grantRevision=2,configurationSha256=id+"-config",config,state="active",capabilities=new{typedCollection=true,preview=true},updatedAt="2026-11-14T00:00:00Z"});
            files[id]=Encoding.UTF8.GetBytes(driftingMiddleSource&&id=="source-b"?content.Replace("Order,","ChangedOrder,"):content);
        }
        var policy=Json.Element(new{state="active",config=(object?)null,configSha256="none",configRevision=0,capabilities=new{typedSourceSubscriptions=true,sourceSubscriptionsSchema="packproof.source-subscriptions/v1"}});
        var previews=new Dictionary<string,JsonElement>();var commits=0;
        var handler=new Replies(async request=>
        {
            object Reply(object body)=>body;
            var path=request.RequestUri!.AbsolutePath;object response;
            if(path=="/v1/partner/agent/heartbeat")response=policy;
            else if(path=="/v1/partner/source-subscriptions")response=new{schema="packproof.source-subscriptions/v1",capabilities=new{typedCollection=true},subscriptions=views,nextCursor=(string?)null};
            else if(path.EndsWith("/heartbeat"))response=new{accepted=true};
            else if(path=="/v1/partner/typed-imports/preview")
            {
                var body=Json.Read<JsonElement>(Encoding.UTF8.GetBytes(await request.Content!.ReadAsStringAsync()));var id=body.GetProperty("subscriptionId").GetString()!;var normalized=TypedSourceSemantics.Preview(Encoding.UTF8.GetBytes(body.GetProperty("original").GetProperty("content").GetString()!),sources.Single(s=>s.Id==id).ApprovedConfiguration!.Value);
                response=new{id="batch-"+id,state="previewed",previewVersion="preview-v1",subscriptionId=id,configurationRevision=1,original=body.GetProperty("original"),rowCount=normalized.Count,counts=new{processing=normalized.Count,acceptedLinked=0,acceptedUnlinked=0,duplicate=0,conflict=0,quarantined=0,rejected=0},rows=normalized.Select((r,i)=>new{index=i,rowNumber=r.RowNumber,normalized=r.Normalized,payloadSha256=r.PayloadSha256,status="processing",caseId=(string?)null}).ToArray(),caseIds=Array.Empty<string>()};previews[id]=Json.Element(response);
            }
            else if(path.EndsWith("/commit"))
            {
                var id=path.Split('/')[4].Replace("batch-","");var preview=previews[id];var normalized=preview.GetProperty("rows").EnumerateArray().Select((r,i)=>new{index=i,rowNumber=r.GetProperty("rowNumber"),normalized=r.GetProperty("normalized"),status="accepted_linked",caseId="case-"+id}).ToArray();
                response=new{id="batch-"+id,state="succeeded",subscriptionId=id,configurationRevision=1,original=preview.GetProperty("original"),rowCount=normalized.Length,counts=new{processing=0,acceptedLinked=normalized.Length,acceptedUnlinked=0,duplicate=0,conflict=0,quarantined=0,rejected=0},rows=normalized,caseIds=new[]{"case-"+id}};commits++;
            }
            else throw new InvalidOperationException("Unexpected typed source request: "+path);
            return new HttpResponseMessage(System.Net.HttpStatusCode.OK){Content=new StringContent(Json.Element(Reply(response)).GetRawText())};
        });
        var host=new HostConfiguration("development","https://api.example.test","https://web.example.test","S-1-5-32-545");var storage=Store();
        using(var runtime=new AgentRuntime(host,storage,new PackProofClient(host,handler),new LocalState{Token="preserved-credential",InstallationId="installation",CredentialExpiresAt=DateTimeOffset.UtcNow.AddDays(30),ServerConfig=policy,SourceSubscriptions=sources},sourceAdapter:()=>new FakeSources(files)))
        {
            await runtime.Tick(default);await runtime.Tick(default);
        }
        using var queue=new DurableQueue(storage);Assert.Equal(driftingMiddleSource?2:3,commits);
        foreach(var source in sources.Where(s=>s.Id!=SourceSubscriptionState.LegacyId))
        {
            var work=Assert.Single(queue.Page(source.Id));Assert.Equal(driftingMiddleSource&&source.Id=="source-b"?"action_needed":"complete",work.State);
            if(driftingMiddleSource&&source.Id=="source-b"){Assert.True(source.LocalPaused);Assert.Equal(files[source.Id],queue.Payload(work).QuarantinedOriginalBytes);}
            else{Assert.False(source.LocalPaused);Assert.Equal(content,queue.Payload(work).Csv);Assert.NotNull(source.LastReceiptAt);}
        }
    }
    public void Dispose(){Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();if(Directory.Exists(root))Directory.Delete(root,true);}
}
