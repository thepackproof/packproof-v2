using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PackProof.Connect;
using Xunit;
public sealed class BackfillRuntimeTests:IDisposable
{
    private readonly string root=Path.Combine(Path.GetTempPath(),"packproof-backfill-"+Guid.NewGuid().ToString("N"));
    private sealed class PlainProtector:ISecretProtector{public byte[] Protect(byte[] b)=>b;public byte[] Unprotect(byte[] b)=>b;}
    private sealed class Reply(Func<HttpRequestMessage,Task<HttpResponseMessage>> respond):HttpMessageHandler{protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)=>respond(request);}
    private sealed class Adapter(Fixture f):ISourceAdapter
    {
        public IReadOnlyList<string> Inspect(SourceSubscriptionState s)=>f.Files.Keys.Where(n=>!s.ExcludedFileNames.Contains(n)&&!s.PublishedFileDigests.ContainsKey(n)).Order(StringComparer.Ordinal).ToArray();
        public CollectedSourceFile Read(SourceSubscriptionState s,string name){f.Reads.Add(name);if(!f.Files.TryGetValue(name,out var bytes))throw new ConnectException("SOURCE_NOT_FOUND","The frozen original is missing.");return new(name,bytes);}
        public void Dispose(){}
    }
    private sealed class Fixture
    {
        public readonly ProtectedStore Store;public readonly HostConfiguration Host=new("staging","https://api.example.test","https://web.example.test","S-1-5-32-545");
        public readonly Dictionary<string,byte[]> Files=new();public readonly List<string> Reads=[];public readonly Dictionary<string,JsonElement> Batches=new();public readonly Dictionary<string,string> Bindings=new();public readonly JsonElement Config;public readonly JsonElement[] Originals;
        public SourceSubscriptionState Source;public LocalState? CurrentState;public string JobState="approved";public int PreviewCount,BindCount,ListCalls,ProposalCount,HistoryCommitCount;public bool PauseNextHistoryCommit,QueueNextHistoryCommit;public string? NextCursor;public List<string> Contexts=[];public Dictionary<string,JsonElement> AdditionalJobs=new();
        public Fixture(string root)
        {
            Store=new(root,new PlainProtector());Store.Initialize();using var corpus=JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"source-contract-corpus-v2.json")));var input=corpus.RootElement.GetProperty("cases")[0].GetProperty("input");var content=input.GetProperty("original").GetProperty("content").GetString()!;
            Files["old-a.csv"]=Encoding.UTF8.GetBytes(content);Files["old-b.csv"]=Encoding.UTF8.GetBytes(content.Replace("0010482","0010483"));Files["live-a.csv"]=Encoding.UTF8.GetBytes(content.Replace("0010482","0010490"));
            var values=input.EnumerateObject().Where(p=>new[]{"sourceProfile","sourceNamespace","mappingVersion","mapping","constants","identityPolicy"}.Contains(p.Name)).ToDictionary(p=>p.Name,p=>(object?)p.Value);values["batchSchema"]="packproof.typed-source-batch/v2";values["transport"]="local_ntfs";values["displayName"]="Qualified snapshots";values["folderDigest"]="approved-folder";values["offlineWindowHours"]=24;values["maxBytes"]=2097152;values["maxRows"]=1000;values["historyFrom"]="2026-01-01T00:00:00Z";Config=Json.Element(values);
            Originals=new[]{"old-a.csv","old-b.csv"}.Select((name,i)=>Json.Element(new{id="item-"+i,name,mediaType="text/csv",sha256=Convert.ToHexStringLower(SHA256.HashData(Files[name])),byteSize=Files[name].Length})).ToArray();
            Source=new(){Id="source-a",SourceProfile=input.GetProperty("sourceProfile").GetString()!,Folder="fake-approved-folder",FolderDigest="approved-folder",ApprovedConfiguration=Config,ConfigurationSha256="config-sha",ConfigurationRevision=1,GrantRevision=3,CapabilityApproved=true,LocalPaused=false,ServerState="active",ExcludedFileNames=["old-a.csv","old-b.csv"]};
        }
        public JsonElement Job()
        {
            var finished=Originals.All(o=>Bindings.TryGetValue(o.GetProperty("id").GetString()!,out var batch)&&Batches[batch].GetProperty("state").GetString()=="succeeded");var state=finished?"completed":JobState;
            return Json.Element(new Dictionary<string,object?>{{"schema","packproof.source-backfill/v1"},{"id","job-a"},{"organizationId","org-a"},{"environment","sandbox"},{"principalId","principal-a"},{"connectionId","connection-a"},{"locationId","site-a"},{"operatorMembershipId","operator-a"},{"subscriptionId","source-a"},{"installationId","installation"},{"configurationRevision",1},{"configurationSha256","config-sha"},{"grantRevision",3},{"manifestSha256","manifest-sha"},{"historyFrom","2026-11-01T00:00:00Z"},{"historyTo","2026-11-14T23:59:59Z"},{"semantics","cumulative_snapshot"},{"state",state},{"approvalExpiresAt",DateTimeOffset.UtcNow.AddHours(1).ToString("O")},{"createdAt","2026-11-14T00:00:00Z"},{"approvalPath","/app/records/connect/approve?subscriptionId=source-a&backfillJobId=job-a&organizationId=org-a&environment=sandbox"},{"originals",Originals.Select(o=>{var d=o.EnumerateObject().ToDictionary(p=>p.Name,p=>(object?)p.Value);Bindings.TryGetValue(o.GetProperty("id").GetString()!,out var batch);d["batchId"]=batch;d["receiptState"]=batch is null?null:Batches[batch].GetProperty("state").GetString();d["counts"]=batch is null?null:Batches[batch].GetProperty("counts");return d;}).ToArray()},{"progress",new{files=new{total=2,received=Bindings.Count,pending=2-Bindings.Count,processing=0,succeeded=Bindings.Count,failed=0},rows=new{processing=0,acceptedLinked=Bindings.Count*2,acceptedUnlinked=0,duplicate=0,conflict=0,quarantined=0,rejected=0},receivedRows=Bindings.Count*2}},{"capabilities",new{collect=state=="approved",approve=false,pause=false,resume=false}},{"blockReason",null}});
        }
        private JsonElement Receipt(JsonElement body,string id,bool complete)
        {
            var rows=TypedSourceSemantics.Preview(Encoding.UTF8.GetBytes(body.GetProperty("original").GetProperty("content").GetString()!),Config);
            return Json.Element(new{id,state=complete?"succeeded":"previewed",previewVersion="preview-v1",subscriptionId="source-a",configurationRevision=1,original=body.GetProperty("original"),rowCount=rows.Count,counts=new{processing=complete?0:rows.Count,acceptedLinked=complete?rows.Count:0,acceptedUnlinked=0,duplicate=0,conflict=0,quarantined=0,rejected=0},rows=rows.Select((r,i)=>new{index=i,rowNumber=r.RowNumber,normalized=r.Normalized,payloadSha256=r.PayloadSha256,status=complete?"accepted_linked":"processing",caseId=complete?"case-a":null}).ToArray(),caseIds=complete?new[]{"case-a"}:[]});
        }
        public AgentRuntime Runtime(bool restore=false)
        {
            object Policy()=>new{state="active",integrationAccountId="connection-a",operatorMembershipId="operator-a",sourceName="Fixture",config=(object?)null,configSha256="none",configRevision=0,capabilities=new{typedSourceSubscriptions=true,sourceBackfillJobs=true,sourceSubscriptionsSchema="packproof.source-subscriptions/v1"}};
            var handler=new Reply(async request=>{
                var path=request.RequestUri!.AbsolutePath;object response;
                if(path=="/v1/partner/agent/heartbeat")response=Policy();
                else if(path=="/v1/partner/source-subscriptions")response=new{schema="packproof.source-subscriptions/v1",capabilities=new{typedCollection=true},subscriptions=new[]{new{id="source-a",organizationId="org-a",environment="sandbox",principalId="principal-a",installationId="installation",connectionId="connection-a",locationId="site-a",operatorMembershipId="operator-a",configurationRevision=1,grantRevision=3,configurationSha256="config-sha",config=Config,state="active",capabilities=new{typedCollection=true,preview=true,sourceBackfillJobs=true,backfillProposal=true,backfillSemantics="cumulative_snapshot"},updatedAt="2026-11-14T00:00:00Z"}}};
                else if(path=="/v1/partner/source-subscriptions/source-a/backfills"){ListCalls++;response=new{schema="packproof.source-backfills/v1",jobs=new[]{Job()}.Concat(AdditionalJobs.Values),nextCursor=NextCursor};}
                else if(path=="/v1/partner/source-backfills/job-a")response=Job();
                else if(AdditionalJobs.TryGetValue(path.Split('/').Last(),out var additional))response=additional;
                else if(path=="/v1/partner/source-subscriptions/source-a/backfills/proposals"){ProposalCount++;response=Job();}
                else if(path=="/v1/partner/typed-imports/preview")
                {
                    PreviewCount++;var body=JsonDocument.Parse(await request.Content!.ReadAsStringAsync()).RootElement.Clone();var id="batch-"+PreviewCount;var preview=Receipt(body,id,false);Batches[id]=preview;Bodies[id]=body;
                    if(body.TryGetProperty("collectionContext",out var ctx)){Contexts.Add(ctx.GetProperty("itemId").GetString()!);Bindings[ctx.GetProperty("itemId").GetString()!]=id;}
                    response=preview;
                }
                else if(path.EndsWith("/commit"))
                {
                    var id=path.Split('/')[4];var historical=Bodies[id].TryGetProperty("collectionContext",out _);
                    if(historical)HistoryCommitCount++;
                    if(historical&&PauseNextHistoryCommit){PauseNextHistoryCommit=false;JobState="paused";var denied=new HttpResponseMessage(HttpStatusCode.Forbidden){Content=new StringContent("{\"code\":\"SOURCE_BACKFILL_NOT_APPROVED\"}")};denied.Headers.Date=DateTimeOffset.UtcNow;return denied;}
                    if(historical&&QueueNextHistoryCommit){QueueNextHistoryCommit=false;var pending=Receipt(Bodies[id],id,false).EnumerateObject().ToDictionary(p=>p.Name,p=>(object?)p.Value);pending["state"]="queued";response=Batches[id]=Json.Element(pending);}
                    else response=Batches[id]=Receipt(Bodies[id],id,true);
                }
                else if(path.StartsWith("/v1/partner/typed-imports/"))response=Batches[path.Split('/')[4]];
                else if(path.Contains("/items/")&&path.EndsWith("/bind")){BindCount++;var item=path.Split('/')[6];var body=JsonDocument.Parse(await request.Content!.ReadAsStringAsync()).RootElement;Bindings[item]=body.GetProperty("batchId").GetString()!;response=new{accepted=true};}
                else if(path.EndsWith("/heartbeat"))response=new{accepted=true};
                else throw new InvalidOperationException("Unexpected fixture request "+path);
                var result=new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(Json.Element(response).GetRawText())};result.Headers.Date=DateTimeOffset.UtcNow;return result;
            });
            var state=restore?Store.Read<LocalState>("state.bin")!:new LocalState{Token="preserved-credential",InstallationId="installation",CredentialExpiresAt=DateTimeOffset.UtcNow.AddDays(30),ServerConfig=Json.Element(Policy()),SourceSubscriptions=[Source]};
            CurrentState=state;Source=state.SourceSubscriptions.Single(s=>s.Id=="source-a");return new(Host,Store,new PackProofClient(Host,handler),state,sourceAdapter:()=>new Adapter(this));
        }
        public Dictionary<string,JsonElement> Bodies=new();
        public void Complete(string id)=>Batches[id]=Receipt(Bodies[id],id,true);
    }
    [Fact]public async Task Multiple_history_originals_resume_after_restart_while_live_discovery_and_processing_continue()
    {
        var f=new Fixture(root);using(var first=f.Runtime()){await first.Tick(default);Assert.Contains("old-a.csv",f.Reads);Assert.DoesNotContain("old-b.csv",f.Reads);}
        using(var queue=new DurableQueue(f.Store)){Assert.Equal(2,queue.Entries().Count);Assert.All(queue.Entries(),e=>Assert.Equal("complete",e.State));}
        f.Files["live-b.csv"]=Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(f.Files["live-a.csv"]).Replace("0010490","0010491"));
        using(var resumed=f.Runtime(restore:true)){f.Source.LastCheckAt=null;await resumed.Tick(default);await resumed.Tick(default);}
        Assert.Equal(1,f.Reads.Count(n=>n=="old-a.csv"));Assert.Equal(1,f.Reads.Count(n=>n=="old-b.csv"));Assert.Equal(2,f.Contexts.Count);Assert.Contains("live-b.csv",f.Reads);Assert.Equal(new[]{"old-a.csv","old-b.csv"},f.Source.ExcludedFileNames);Assert.Equal("live-b.csv",f.Source.CursorFileName);
        using var retained=new DurableQueue(f.Store);Assert.Equal(4,retained.Entries().Count);Assert.All(retained.Entries(),e=>Assert.Equal("complete",e.State));Assert.Equal(2,f.Bindings.Count);
    }
    [Fact]public async Task Blocked_approved_job_yields_to_another_job_after_restart()
    {
        var f=new Fixture(root);var second=f.Job().EnumerateObject().ToDictionary(p=>p.Name,p=>(object?)p.Value);second["id"]="job-b";second["manifestSha256"]="second-manifest";second["originals"]=new[]{f.Originals[1]};f.AdditionalJobs["job-b"]=Json.Element(second);
        using(var queue=new DurableQueue(f.Store))foreach(var original in f.Originals)queue.BackfillFailure("job-a",original.GetProperty("id").GetString()!,"manifest-sha","SOURCE_BACKFILL_ORIGINAL_CHANGED");
        using(var first=f.Runtime()){await first.Tick(default);Assert.DoesNotContain("old-a.csv",f.Reads);Assert.DoesNotContain("old-b.csv",f.Reads);Assert.Equal("job-a",f.Source.LastScheduledBackfillJobId);}
        using(var resumed=f.Runtime(restore:true)){await resumed.Tick(default);Assert.Equal("job-b",f.Source.LastScheduledBackfillJobId);}
        Assert.Contains("old-b.csv",f.Reads);Assert.DoesNotContain("old-a.csv",f.Reads);Assert.Contains("live-a.csv",f.Reads);Assert.Equal(1,f.Reads.Count(n=>n=="old-b.csv"));
    }
    [Fact]public async Task Proposed_and_locally_paused_jobs_do_not_read_history_and_explicit_resume_uses_current_approval()
    {
        var f=new Fixture(root){JobState="proposed"};using var runtime=f.Runtime();await runtime.Tick(default);Assert.DoesNotContain("old-a.csv",f.Reads);
        f.JobState="approved";await runtime.Tick(default);Assert.Contains("old-a.csv",f.Reads);
        await runtime.Command("pauseBackfill",Json.Element(new{id="source-a",jobId="job-a"}),default);await runtime.Tick(default);Assert.DoesNotContain("old-b.csv",f.Reads);
        f.JobState="expired";await Assert.ThrowsAsync<ConnectException>(()=>runtime.Command("resumeBackfill",Json.Element(new{id="source-a",jobId="job-a"}),default));await runtime.Tick(default);Assert.DoesNotContain("old-b.csv",f.Reads);
        f.JobState="approved";await runtime.Command("resumeBackfill",Json.Element(new{id="source-a",jobId="job-a"}),default);await runtime.Tick(default);Assert.Contains("old-b.csv",f.Reads);
    }
    [Fact]public async Task Changed_manifest_file_blocks_that_item_and_preserves_live_source_and_other_history_items()
    {
        var f=new Fixture(root);f.Files["old-a.csv"]=Encoding.UTF8.GetBytes("changed after approval");using var runtime=f.Runtime();await runtime.Tick(default);Assert.False(f.Source.LocalPaused);
        f.Files["live-b.csv"]=Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(f.Files["live-a.csv"]).Replace("0010490","0010491"));f.Source.LastCheckAt=null;await runtime.Tick(default);
        Assert.Contains("live-b.csv",f.Reads);Assert.Contains("old-b.csv",f.Reads);Assert.False(f.Source.LocalPaused);using var queue=new DurableQueue(f.Store);Assert.Equal("SOURCE_BACKFILL_ORIGINAL_CHANGED",queue.BackfillItemError("job-a","item-0"));Assert.Null(queue.BackfillQueueId("job-a","item-0"));
    }
    [Fact]public async Task Automatic_job_discovery_reads_only_one_page_per_turn_and_persists_its_cursor()
    {
        var f=new Fixture(root){JobState="proposed",NextCursor="page-two"};using(var runtime=f.Runtime()){await runtime.Tick(default);Assert.Equal(1,f.ListCalls);Assert.Equal("page-two",f.Source.BackfillDiscoveryCursor);}
        Assert.Equal("page-two",f.Store.Read<LocalState>("state.bin")!.SourceSubscriptions.Single(s=>s.Id=="source-a").BackfillDiscoveryCursor);
    }
    [Fact]public async Task Historical_review_refresh_remains_available_without_proposal_or_collection_authority()
    {
        var f=new Fixture(root){JobState="proposed"};using var runtime=f.Runtime();await runtime.Tick(default);var reads=f.Reads.Count;var calls=f.ListCalls;f.Source.ServerState="paused";
        var view=f.Source.ServerView!.Value.EnumerateObject().ToDictionary(p=>p.Name,p=>(object?)p.Value);view["capabilities"]=new{sourceBackfillJobs=true,backfillProposal=false};f.Source.ServerView=Json.Element(view);
        await runtime.Command("refreshBackfills",Json.Element(new{id="source-a"}),default);Assert.Equal(calls+1,f.ListCalls);Assert.Equal(reads,f.Reads.Count);
        await Assert.ThrowsAsync<ConnectException>(()=>runtime.Command("inspectBackfill",Json.Element(new{id="source-a",fileNames=new[]{"old-a.csv"},historyFrom="2026-11-01T00:00:00Z",historyTo="2026-11-14T23:59:59Z",semantics="cumulative_snapshot"}),default));Assert.Equal(reads,f.Reads.Count);
    }
    [Fact]public async Task Inspection_requires_exact_window_and_proposal_rechecks_the_frozen_bytes()
    {
        var f=new Fixture(root){JobState="proposed"};using var runtime=f.Runtime();await runtime.Tick(default);
        var inspect=Json.Element(new{id="source-a",fileNames=new[]{"old-a.csv","old-b.csv"},historyFrom="2026-11-01T00:00:00Z",historyTo="2026-11-14T23:59:59Z",semantics="cumulative_snapshot"});
        await runtime.Command("inspectBackfill",inspect,default);var draft=f.Source.BackfillDraft!.Value;Assert.Equal(2,draft.GetProperty("originalCount").GetInt32());var sha=draft.GetProperty("inspectionSha256").GetString();
        var original=f.Files["old-b.csv"];f.Files["old-b.csv"]="replaced"u8.ToArray();await Assert.ThrowsAsync<ConnectException>(()=>runtime.Command("proposeBackfill",Json.Element(new{id="source-a",inspectionSha256=sha,wholeFileUploadApproved=true}),default));Assert.Equal(0,f.ProposalCount);
        f.Files["old-b.csv"]=original;await runtime.Command("proposeBackfill",Json.Element(new{id="source-a",inspectionSha256=sha,wholeFileUploadApproved=true}),default);Assert.Equal(1,f.ProposalCount);Assert.Null(f.Source.BackfillDraft);
        await Assert.ThrowsAsync<ConnectException>(()=>runtime.Command("inspectBackfill",Json.Element(new{id="source-a",fileNames=new[]{"old-a.csv"},historyFrom="2026-11-13T00:00:00Z",historyTo="2026-11-14T00:00:00Z",semantics="cumulative_snapshot"}),default));
    }
    [Fact]public async Task A_policy_pause_during_commit_resumes_same_retained_keys_without_stopping_live()
    {
        var f=new Fixture(root){PauseNextHistoryCommit=true};using var runtime=f.Runtime();await runtime.Tick(default);Assert.False(f.Source.LocalPaused);QueueEntry blocked;byte[]? wire;
        using(var q=new DurableQueue(f.Store)){blocked=q.Find(q.BackfillQueueId("job-a","item-0")!)!;Assert.Equal("action_needed",blocked.State);wire=q.Payload(blocked).PreviewWireBody;}
        f.JobState="approved";await runtime.Command("resumeBackfill",Json.Element(new{id="source-a",jobId="job-a"}),default);f.Files["live-b.csv"]=Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(f.Files["live-a.csv"]).Replace("0010490","0010491"));f.Source.LastCheckAt=null;await runtime.Tick(default);
        using var retained=new DurableQueue(f.Store);var same=retained.Find(blocked.Id)!;Assert.Equal("complete",same.State);Assert.Equal(blocked.PreviewKey,same.PreviewKey);Assert.Equal(blocked.CommitKey,same.CommitKey);Assert.Equal(wire,retained.Payload(same).PreviewWireBody);Assert.Contains("live-b.csv",f.Reads);Assert.False(f.Source.LocalPaused);
    }
    [Fact]public async Task Expired_jobs_can_reconcile_already_accepted_terminal_receipts_without_new_history_reads()
    {
        var f=new Fixture(root){QueueNextHistoryCommit=true};using var runtime=f.Runtime();await runtime.Tick(default);var batch=f.Bindings["item-0"];f.Complete(batch);f.JobState="expired";await runtime.Tick(default);
        using var q=new DurableQueue(f.Store);Assert.Equal("complete",q.Find(q.BackfillQueueId("job-a","item-0")!)!.State);Assert.DoesNotContain("old-b.csv",f.Reads);Assert.Equal(1,f.Reads.Count(n=>n=="old-a.csv"));
    }
    [Fact]public async Task Credential_renewal_reconciliation_does_not_commit_a_paused_historical_job_or_pause_live()
    {
        var f=new Fixture(root){PauseNextHistoryCommit=true};using(var first=f.Runtime())await first.Tick(default);
        QueueEntry retained;byte[]? wire;using(var queue=new DurableQueue(f.Store)){retained=queue.Find(queue.BackfillQueueId("job-a","item-0")!)!;var payload=queue.Payload(retained);wire=payload.PreviewWireBody;queue.Save(retained,payload,"commit_pending");}
        var saved=f.Store.Read<LocalState>("state.bin")!;saved.CredentialExpiresAt=DateTimeOffset.UtcNow.AddDays(1);f.Store.Write("state.bin",saved);
        using(var resumed=f.Runtime(restore:true))await resumed.Tick(default);
        Assert.Equal(1,f.HistoryCommitCount);Assert.False(f.Source.LocalPaused);Assert.DoesNotContain("old-b.csv",f.Reads);
        using var preserved=new DurableQueue(f.Store);var same=preserved.Find(retained.Id)!;Assert.Equal("commit_pending",same.State);Assert.Equal(retained.PreviewKey,same.PreviewKey);Assert.Equal(retained.CommitKey,same.CommitKey);Assert.Equal(wire,preserved.Payload(same).PreviewWireBody);
    }
    [Fact]public async Task Locally_paused_history_keeps_its_pause_when_live_overlap_reuses_the_same_original()
    {
        var f=new Fixture(root){PauseNextHistoryCommit=true};using var runtime=f.Runtime();await runtime.Tick(default);QueueEntry retained;
        using(var queue=new DurableQueue(f.Store)){retained=queue.Find(queue.BackfillQueueId("job-a","item-0")!)!;queue.Save(retained,queue.Payload(retained),"commit_pending");}
        f.JobState="approved";await runtime.Command("pauseBackfill",Json.Element(new{id="source-a",jobId="job-a"}),default);f.Source.ExcludedFileNames=["old-b.csv"];f.Source.LastCheckAt=null;await runtime.Tick(default);
        f.Files["live-b.csv"]=Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(f.Files["live-a.csv"]).Replace("0010490","0010491"));f.Source.LastCheckAt=null;await runtime.Tick(default);
        Assert.Equal(1,f.HistoryCommitCount);Assert.False(f.Source.LocalPaused);using var preserved=new DurableQueue(f.Store);Assert.Equal("commit_pending",preserved.Find(retained.Id)!.State);Assert.True(preserved.Find(retained.Id)!.NextAttemptAt>DateTimeOffset.UtcNow);Assert.Contains(preserved.Entries(),e=>preserved.Payload(e).FileName=="live-b.csv"&&e.State=="complete");
    }
    [Fact]public async Task Closed_previewed_receipts_yield_to_other_approved_jobs()
    {
        var f=new Fixture(root){PauseNextHistoryCommit=true};using var runtime=f.Runtime();await runtime.Tick(default);
        using(var queue=new DurableQueue(f.Store)){var retained=queue.Find(queue.BackfillQueueId("job-a","item-0")!)!;queue.Save(retained,queue.Payload(retained),"commit_pending");}
        var second=f.Job().EnumerateObject().ToDictionary(p=>p.Name,p=>(object?)p.Value);second["id"]="job-b";second["manifestSha256"]="second-manifest";second["state"]="approved";second["capabilities"]=new{collect=true,approve=false,pause=false,resume=false};second["originals"]=new[]{f.Originals[1]};f.AdditionalJobs["job-b"]=Json.Element(second);
        await runtime.Tick(default);await runtime.Tick(default);Assert.Contains("old-b.csv",f.Reads);Assert.Equal(1,f.Reads.Count(n=>n=="old-b.csv"));Assert.False(f.Source.LocalPaused);Assert.Equal(2,f.HistoryCommitCount);
    }
    [Fact]public async Task Paused_history_without_a_server_import_yields_live_overlap_to_fresh_live_work()
    {
        var f=new Fixture(root){JobState="proposed"};using var runtime=f.Runtime();await runtime.Tick(default);f.Source.BackfillJobs.Single().LocalPaused=true;QueueEntry history;
        using(var queue=new DurableQueue(f.Store))
        {
            var live=queue.Entries().Single();var body=f.Bodies[live.ImportId!].EnumerateObject().ToDictionary(p=>p.Name,p=>(object?)p.Value);body["original"]=new{name="old-a.csv",mediaType="text/csv",content=Encoding.UTF8.GetString(f.Files["old-a.csv"]),sha256=f.Originals[0].GetProperty("sha256").GetString(),byteSize=f.Files["old-a.csv"].Length};body["collectionContext"]=new{kind="historical_backfill",jobId="job-a",itemId="item-0"};history=queue.StageRequest(f.Files["old-a.csv"],"old-a.csv",Json.Element(body),live.CredentialGeneration,live.ConfigDigest,true,new(f.Source.Id,f.Source.SourceProfile,3),history:true);queue.LinkBackfillItem("job-a","item-0","manifest-sha",history.Id);
        }
        f.JobState="approved";f.Source.ExcludedFileNames=["old-b.csv"];f.Source.LastCheckAt=null;await runtime.Tick(default);f.Files["live-b.csv"]=Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(f.Files["live-a.csv"]).Replace("0010490","0010491"));f.Source.LastCheckAt=null;await runtime.Tick(default);
        using var preserved=new DurableQueue(f.Store);Assert.Equal("staged",preserved.Find(history.Id)!.State);Assert.Null(preserved.Find(history.Id)!.ImportId);Assert.True(preserved.Find(history.Id)!.NextAttemptAt>DateTimeOffset.UtcNow);Assert.Equal(0,f.HistoryCommitCount);Assert.Contains(preserved.Entries(),e=>preserved.Payload(e).FileName=="live-b.csv"&&e.State=="complete");Assert.False(f.Source.LocalPaused);
    }
    [Fact]public async Task Many_full_manifests_and_decisions_share_one_bounded_display_budget_without_changing_protected_jobs()
    {
        var f=new Fixture(root){JobState="proposed"};using var runtime=f.Runtime();await runtime.Tick(default);f.Source.BackfillJobs.Clear();
        for(var j=0;j<100;j++)
        {
            var full=f.Job().EnumerateObject().ToDictionary(p=>p.Name,p=>(object?)p.Value);full["id"]="large-job-"+j;full["originals"]=Enumerable.Range(0,100).Select(i=>new{id="large-item-"+i,name=new string('n',200)+i+".csv",mediaType="text/csv",sha256=Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(j+":"+i))),byteSize=2097152,batchId=(string?)null,receiptState=(string?)null,counts=(object?)null}).ToArray();full["decisions"]=Enumerable.Range(0,100).Select(i=>new{id="decision-"+i,reason=new string('r',1000)}).ToArray();full["decisionsComplete"]=true;full["decisionLimit"]=100;f.Source.BackfillJobs.Add(new(){Id="large-job-"+j,Job=Json.Element(full)});
        }
        var other=Json.Read<SourceSubscriptionState>(Json.Bytes(f.Source));other.Id="source-b";f.CurrentState!.SourceSubscriptions.Add(other);
        var status=Json.Element(await runtime.Command("status",null,default));var sources=status.GetProperty("sourceSubscriptions").EnumerateArray().ToArray();var source=sources.Single(s=>s.GetProperty("id").GetString()=="source-a");var shown=source.GetProperty("backfillJobs").EnumerateArray().ToArray();
        Assert.True(Json.Bytes(new{version=1,id="status",ok=true,result=status}).Length<262144);Assert.InRange(sources.Sum(s=>Json.Bytes(s.GetProperty("backfillJobs")).Length),1,64*1024+4);Assert.NotEmpty(shown);Assert.Equal(shown.Length,source.GetProperty("backfillJobsShown").GetInt32());Assert.Equal(100,source.GetProperty("backfillJobKnownTotal").GetInt32());Assert.True(source.GetProperty("backfillJobsTruncated").GetBoolean());var omitted=sources.Single(s=>s.GetProperty("id").GetString()=="source-b");Assert.Equal(0,omitted.GetProperty("backfillJobsShown").GetInt32());Assert.Equal(100,omitted.GetProperty("backfillJobKnownTotal").GetInt32());Assert.True(omitted.GetProperty("backfillJobsTruncated").GetBoolean());
        Assert.All(shown,job=>{Assert.False(job.TryGetProperty("decisions",out _));Assert.False(job.TryGetProperty("decisionsComplete",out _));Assert.Equal(100,job.GetProperty("originalsTotal").GetInt32());Assert.Equal(job.GetProperty("originals").GetArrayLength(),job.GetProperty("originalsShown").GetInt32());Assert.Equal(job.GetProperty("originalsShown").GetInt32()<100,job.GetProperty("originalsTruncated").GetBoolean());Assert.True(job.GetProperty("progress").GetProperty("files").GetProperty("total").GetInt32()>0);Assert.False(string.IsNullOrEmpty(job.GetProperty("approvalPath").GetString()));});
        Assert.Contains(shown,job=>job.GetProperty("originalsTruncated").GetBoolean());Assert.All(f.Source.BackfillJobs,job=>{Assert.Equal(100,job.Job.GetProperty("originals").GetArrayLength());Assert.Equal(100,job.Job.GetProperty("decisions").GetArrayLength());Assert.True(job.Job.GetProperty("decisionsComplete").GetBoolean());});
    }
    [Fact]public async Task Raw_empty_business_rows_cannot_be_dropped_during_local_history_qualification()
    {
        var f=new Fixture(root){JobState="proposed"};using var runtime=f.Runtime();await runtime.Tick(default);f.Files["old-a.csv"]=Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(f.Files["old-a.csv"]).Replace("\n0010482,005","\n\n0010482,005"));
        await Assert.ThrowsAsync<ConnectException>(()=>runtime.Command("inspectBackfill",Json.Element(new{id="source-a",fileNames=new[]{"old-a.csv"},historyFrom="2026-11-01T00:00:00Z",historyTo="2026-11-14T23:59:59Z",semantics="cumulative_snapshot"}),default));Assert.Equal(0,f.ProposalCount);
    }
    public void Dispose(){Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();if(Directory.Exists(root))Directory.Delete(root,true);}
}
