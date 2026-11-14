using System.Net;
using System.Security.Cryptography;
using System.Text;
using PackProof.Connect;
using Xunit;
public sealed class GlobalSourcePauseTests:IDisposable
{
    private readonly string root=Path.Combine(Path.GetTempPath(),"packproof-global-source-pause-"+Guid.NewGuid().ToString("N"));
    private sealed class PlainProtector:ISecretProtector{public byte[] Protect(byte[] b)=>b;public byte[] Unprotect(byte[] b)=>b;}
    private sealed class Sources:ISourceAdapter
    {
        public int Inspections,Reads;
        public IReadOnlyList<string> Inspect(SourceSubscriptionState source){Inspections++;throw new InvalidOperationException("Global hold must prevent source inspection");}
        public CollectedSourceFile Read(SourceSubscriptionState source,string name){Reads++;throw new InvalidOperationException("Global hold must prevent source reads");}
        public void Dispose(){}
    }
    private sealed class Reply(Func<HttpRequestMessage,HttpResponseMessage> respond):HttpMessageHandler
    {protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)=>Task.FromResult(respond(request));}
    [Theory][InlineData("paused",false,"active")][InlineData("revoked",false,"active")][InlineData("needs_approval",false,"active")][InlineData("paused",true,"active")][InlineData("active",false,"revoked")][InlineData("active",false,"paused")]
    public async Task Successful_hold_refresh_stops_new_source_reads_despite_cached_active_grant_and_keeps_pending_bytes(string globalState,bool acknowledgedPendingWork,string sourceServerState)
    {
        var store=new ProtectedStore(root,new PlainProtector());store.Initialize();
        var config=Json.Element(new{transport="local_ntfs",displayName="Orders",sourceProfile="packproof.order-lines/v1",folderDigest="approved-folder",offlineWindowHours=24});
        var source=new SourceSubscriptionState{Id="source-a",SourceProfile="packproof.order-lines/v1",Folder="never-inspected-under-global-hold",FolderDigest="approved-folder",ApprovedConfiguration=config,ConfigurationSha256="approved-config",ConfigurationRevision=2,GrantRevision=4,ServerState="active",CapabilityApproved=true,LocalPaused=false};
        object Policy(string state)=>new{state,integrationAccountId="connection-a",operatorMembershipId="operator-a",sourceName="Installed source",config=(object?)null,configSha256="none",configRevision=0,capabilities=new{typedSourceSubscriptions=true,sourceSubscriptionsSchema="packproof.source-subscriptions/v1"}};
        var token="preserved-credential";var generation=Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)));QueueEntry pending;byte[] encryptedBefore;
        using(var queue=new DurableQueue(store)){pending=queue.StageRequest("retain exact pending bytes"u8.ToArray(),"pending.csv",Json.Element(new{original="retained request"}),generation,source.QueueConfigurationIdentity("installation"),true,new(source.Id,source.SourceProfile,source.GrantRevision));if(acknowledgedPendingWork){var payload=queue.Payload(pending);payload.Receipt=Json.Element(new{id="batch-existing",state="queued",original=new{sha256=pending.Digest}});queue.Save(pending,payload,"server_processing","batch-existing");pending=queue.Find(pending.Id)!;source.SetupQueueId=pending.Id;}}
        encryptedBefore=File.ReadAllBytes(Path.Combine(root,"spool",pending.PayloadPath));
        var heartbeats=0;var discovery=0;var sources=new Sources();var adapterCreations=0;
        var handler=new Reply(request=>{
            object response;var path=request.RequestUri!.AbsolutePath;
            if(path=="/v1/partner/agent/heartbeat"){heartbeats++;response=Policy(globalState);}
            else if(path=="/v1/partner/source-subscriptions"){discovery++;response=new{schema="packproof.source-subscriptions/v1",capabilities=new{typedCollection=true},subscriptions=new[]{new{id=source.Id,installationId="installation",connectionId="connection-a",locationId="site-a",configurationRevision=2,grantRevision=4,configurationSha256="approved-config",config,state=sourceServerState,capabilities=new{typedCollection=true,preview=true},updatedAt="2026-11-14T00:00:00Z"}}};}
            else throw new InvalidOperationException("A global hold must not submit or reconcile retained work without current policy: "+path);
            return new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(Json.Element(response).GetRawText())};
        });
        var host=new HostConfiguration("staging","https://api.example.test","https://web.example.test","S-1-5-32-545");
        using(var runtime=new AgentRuntime(host,store,new PackProofClient(host,handler),new LocalState{Token=token,InstallationId="installation",CredentialExpiresAt=DateTimeOffset.UtcNow.AddDays(30),ServerConfig=Json.Element(Policy("active")),SourceSubscriptions=[source]},sourceAdapter:()=>{adapterCreations++;return sources;}))
        {
            await runtime.Tick(default);await runtime.Tick(default);_ = await runtime.Command("status",null,default);
            foreach(var operation in new[]{"inspectSubscriptionFile","previewSubscription","commitSubscription","verifySubscription"})
            {
                var error=await Assert.ThrowsAsync<ConnectException>(()=>runtime.Command(operation,Json.Element(new{id=source.Id,fileName="new.csv",wholeFileUploadApproved=true,wholeBatchApproved=true}),default));Assert.Equal(globalState=="active"?"SOURCE_AUTHORIZATION_REQUIRED":"AGENT_AUTHORIZATION_REQUIRED",error.Code);
            }
            if(globalState!="active"){var draft=await Assert.ThrowsAsync<ConnectException>(()=>runtime.Command("beginSubscriptionSource",Json.Element(new{folder="not-inspected-under-hold"}),default));Assert.Equal("AGENT_AUTHORIZATION_REQUIRED",draft.Code);}
        }
        Assert.Equal(1,heartbeats);Assert.Equal(1,discovery);Assert.Equal(0,adapterCreations);Assert.Equal(0,sources.Inspections);Assert.Equal(0,sources.Reads);
        using var retained=new DurableQueue(store);Assert.Single(retained.Entries());Assert.Equal(pending,retained.Find(pending.Id));Assert.Equal("retain exact pending bytes",retained.Payload(pending).Csv);Assert.Equal(encryptedBefore,File.ReadAllBytes(Path.Combine(root,"spool",pending.PayloadPath)));
    }
    public void Dispose(){Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();if(Directory.Exists(root))Directory.Delete(root,true);}
}
