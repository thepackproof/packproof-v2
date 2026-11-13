using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using PackProof.Connect;
using Xunit;

// Transport/queue integration only. Native source identity and filesystem trust
// are deliberately tested separately by the packaged Windows service smoke.
public sealed class GuidedSetupTests : IDisposable
{
    private readonly string root=Path.Combine(Path.GetTempPath(),"connect-guided-"+Guid.NewGuid().ToString("N"));
    private static readonly byte[] Original=Encoding.UTF8.GetBytes("Shipment reference,Description,Quantity,Shipment date\nSHIP-001,TEST ONLY - Elbow,12,2026-11-13T09:00:00Z\n");
    private static readonly string Digest=Convert.ToHexStringLower(SHA256.HashData(Original));
    private static HostConfiguration Host()=>new("development","https://api.example","https://app.example","S-1-5-21-1-2-3-1001");
    private sealed class PlainProtector:ISecretProtector {public byte[] Protect(byte[] b)=>b.ToArray();public byte[] Unprotect(byte[] b)=>b.ToArray();}
    private sealed class Handler(Func<HttpRequestMessage,JsonElement> reply):HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)
        {var response=new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(reply(request).GetRawText())};response.Headers.Date=DateTimeOffset.UtcNow;return Task.FromResult(response);}
    }
    private static JsonElement Configuration()=>Json.Element(new{folderDigest="folder",sourceName="Synthetic",integrationAccountId="source",operatorMembershipId="operator",mapping=new{shipmentReference="Shipment reference",itemTitle="Description",quantity="Quantity",shippedAt="Shipment date"},timeZone="source-offset",importValidRows=false,offlineWindowHours=24,sourceContract=new{schema="packproof.scheduled-csv/v2",rulesVersion=CsvSemantics.Version,profileVersion=CsvSemantics.Profile,confirmedFields=Array.Empty<string>(),expectedHeaders=new[]{"Shipment reference","Description","Quantity","Shipment date"},backfillFrom="2026-11-13T00:00:00Z",historyPolicy=new{baselineSha256="baseline"}}});
    private static JsonElement Normalized(int quantity=12)=>Json.Element(new{shipmentReference="SHIP-001",itemTitle="TEST ONLY - Elbow",quantity,shippedAt="2026-11-13T09:00:00Z",shipmentDate="2026-11-13"});
    private static JsonElement Receipt(string status,int quantity=12)=>Json.Element(new{id="import-fixture",previewVersion="v",state=status,original=new{sha256=Digest,byteSize=Original.Length},counts=new{valid=status=="succeeded"?0:1,imported=status=="succeeded"?1:0,duplicate=0,invalid=0,ambiguous=0,failed=0},rows=new[]{new{rowNumber=2,status=status=="succeeded"?"imported":"valid",values=new Dictionary<string,string>(),normalized=Normalized(quantity),payloadSha256="normalized-fixture",proofId=status=="succeeded"?"proof-fixture":null,errors=Array.Empty<string>()}},recordIds=status=="succeeded"?new[]{"proof-fixture"}:Array.Empty<string>()});
    private static JsonElement Policy(bool approved=false,bool verified=false,bool active=false)=>Json.Element(new{state=active?"active":"ready",config=Configuration(),configSha256="approved",configRevision=1,integrationAccountId="source",operatorMembershipId="operator",sourceName="Synthetic",testImportId=approved?"import-fixture":null,verifiedImportId=verified?"import-fixture":null,credentialExpiresAt=DateTimeOffset.UtcNow.AddDays(20)});
    private ProtectedStore Store(){var store=new ProtectedStore(root,new PlainProtector());store.Initialize();return store;}
    private static LocalState State()=>new(){Token="synthetic-secret",InstallationId="installation-fixture",Folder="synthetic-folder",FolderDigest="folder",FileName="synthetic.csv",FileDigest=Digest,CredentialExpiresAt=DateTimeOffset.UtcNow.AddDays(20),ServerConfig=Policy(),LastPolicyCheckAt=DateTimeOffset.UtcNow,GuidedSetup=true,GuidedProposalSha256="approved",GuidedFileSha256=Digest,GuidedPhase="permission_review",LocalPaused=true};
    [Fact] public async Task Guided_setup_survives_restart_and_requires_exact_batch_then_separate_recurring_approval()
    {
        var approved=false;var terminal=false;var verified=false;var active=false;var previews=0;var commits=0;
        JsonElement Reply(HttpRequestMessage request){
            var path=request.RequestUri!.AbsolutePath;
            if(path.EndsWith("heartbeat")){
                var body=JsonDocument.Parse(request.Content!.ReadAsStringAsync().Result).RootElement;
                if(body.TryGetProperty("verifiedImportId",out var receipt)&&receipt.ValueKind==JsonValueKind.String){Assert.True(terminal);Assert.Equal("import-fixture",receipt.GetString());verified=true;}
                return Policy(approved,verified,active);
            }
            if(path.EndsWith("/preview")){previews++;Assert.Contains("SHIP-001",request.Content!.ReadAsStringAsync().Result);return Receipt("previewed");}
            if(path.EndsWith("/commit")){Assert.True(approved);commits++;return Receipt("queued");}
            if(path.Contains("/proofs/")){Assert.True(terminal);return Json.Element(new{proof=new{proofId="proof-fixture",transaction=new{itemTitle="TEST ONLY - Elbow",quantity=12,shipping=new{shipmentDate="2026-11-13"}},events=new[]{new{eventType="SERVICE_CSV_SHIPMENT_IMPORTED",data=new{payloadSha256="normalized-fixture",sourceReportedAt="2026-11-13T09:00:00Z",sourceName="Synthetic",originalSha256=Digest}}}}});}
            return Receipt(terminal?"succeeded":"previewed");
        }
        var state=State();var storage=Store();
        using(var runtime=new AgentRuntime(Host(),storage,new PackProofClient(Host(),new Handler(Reply)),state,(_,_)=>Original)){
            await runtime.Tick(default);Assert.Equal("batch_review",state.GuidedPhase);Assert.Equal(1,previews);Assert.Equal(0,commits);Assert.True(state.LocalPaused);
        }
        state=storage.Read<LocalState>("state.bin")!;Assert.True(state.GuidedSetup);Assert.NotNull(state.SetupQueueId);
        using(var runtime=new AgentRuntime(Host(),storage,new PackProofClient(Host(),new Handler(Reply)),state,(_,_)=>Original)){
            await runtime.Tick(default);Assert.Equal(1,previews);Assert.Equal(0,commits);
            approved=true;await runtime.Command("refresh",null,default);await runtime.Tick(default);Assert.Equal(1,commits);Assert.True(state.LocalPaused);
            terminal=true;await runtime.Tick(default);Assert.Equal("recurring_approval_pending",state.GuidedPhase);Assert.Equal("proof-fixture",state.VerifiedRecordId);Assert.True(verified);Assert.True(state.LocalPaused);
            active=true;await runtime.Command("refresh",null,default);await runtime.Tick(default);Assert.Equal("active",state.GuidedPhase);Assert.False(state.GuidedSetup);Assert.False(state.LocalPaused);Assert.Equal(1,previews);Assert.Equal(1,commits);
        }
    }
    [Fact] public async Task A_server_interpretation_mismatch_preserves_the_queue_and_cannot_commit()
    {
        var commits=0;var state=State();using var runtime=new AgentRuntime(Host(),Store(),new PackProofClient(Host(),new Handler(request=>{
            if(request.RequestUri!.AbsolutePath.EndsWith("heartbeat"))return Policy();
            if(request.RequestUri.AbsolutePath.EndsWith("commit"))commits++;
            return Receipt("previewed",1);
        })),state,(_,_)=>Original);
        await runtime.Tick(default);Assert.Equal(0,commits);Assert.True(state.LocalPaused);Assert.Equal("INTERPRETATION_MISMATCH",state.LastErrorCode);Assert.NotNull(state.SetupQueueId);
    }
    [Fact] public async Task A_changed_initial_report_cannot_commit_a_previously_approved_receipt()
    {
        var approved=false;var changed=false;var commits=0;var state=State();
        using var runtime=new AgentRuntime(Host(),Store(),new PackProofClient(Host(),new Handler(request=>{
            if(request.RequestUri!.AbsolutePath.EndsWith("heartbeat"))return Policy(approved);
            if(request.RequestUri.AbsolutePath.EndsWith("commit"))commits++;
            return Receipt("previewed");
        })),state,(_,_)=>changed?Encoding.UTF8.GetBytes("changed report"):Original);
        await runtime.Tick(default);approved=true;changed=true;await runtime.Command("refresh",null,default);await runtime.Tick(default);
        Assert.Equal(0,commits);Assert.Equal("SOURCE_CHANGED",state.LastErrorCode);Assert.False(state.GuidedSetup);Assert.True(state.LocalPaused);Assert.NotNull(state.SetupQueueId);
    }
    [Fact] public async Task A_new_client_refuses_an_old_server_before_reading_or_uploading_the_original()
    {
        var state=State();state.DraftRevision=1;state.LocalAnalysis=Json.Element(new{ready=true});var reads=0;var requests=0;
        using var runtime=new AgentRuntime(Host(),Store(),new PackProofClient(Host(),new Handler(request=>{requests++;Assert.EndsWith("heartbeat",request.RequestUri!.AbsolutePath);return Policy();})),state,(_,_)=>{reads++;return Original;});
        var error=await Assert.ThrowsAsync<ConnectException>(()=>runtime.Command("startSetup",Json.Element(new{wholeFileUploadApproved=true,draftRevision=1}),default));
        Assert.Equal("SOURCE_CONTRACT_UNSUPPORTED",error.Code);Assert.Equal(1,requests);Assert.Equal(0,reads);
    }
    public void Dispose(){using var connection=new SqliteConnection(new SqliteConnectionStringBuilder{DataSource=Path.Combine(root,"queue.sqlite"),Mode=SqliteOpenMode.ReadWriteCreate}.ToString());SqliteConnection.ClearPool(connection);if(Directory.Exists(root))Directory.Delete(root,true);}
}
