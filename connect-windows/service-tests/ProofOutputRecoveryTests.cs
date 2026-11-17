using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using PackProof.Connect;
using Xunit;

public sealed class ProofOutputRecoveryTests : IDisposable
{
    private readonly string root=Directory.CreateTempSubdirectory("output-recovery-").FullName;
    private sealed class Protector:ISecretProtector
    {
        public byte[] Protect(byte[] b)=>b.ToArray();
        public byte[] Unprotect(byte[] b)=>b.ToArray();
    }
    private sealed class Server : HttpMessageHandler
    {
        internal int Revision=1;
        internal static readonly byte[] Label=Encoding.ASCII.GetBytes("^XA^FDSAMPLE LABEL^FS^XZ");
        internal static readonly string LabelHash=Convert.ToHexStringLower(SHA256.HashData(Label));
        private static readonly object Link=new {receiptId="label_receipt", sourceId="shipping", originalSha256=LabelHash,
            mediaType="application/zpl",fileName="label.zpl",linkedByReceiptId="label_sidecar"};
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)
        {
            Assert.Equal("owned-installation",request.Headers.Authorization?.Parameter);
            var path=request.RequestUri!.AbsolutePath;
            JsonElement result;
            if(path=="/v1/partner/agent/order-changes")
            {
                var after=Json.Read<JsonElement>(await request.Content!.ReadAsByteArrayAsync(ct)).GetProperty("after").GetInt32();
                result=Json.Element(new{changes=Enumerable.Range(after+1,Revision-after).Select(r=>new{sequence=r,proofId="cloudOrder",revision=r}),nextCursor=Revision,hasMore=false});
            }
            else if(path=="/v1/partner/agent/order-proofs/cloudOrder/revisions/2/artifacts/label_receipt")
                result=Json.Element(new {kind="original",receiptId="label_receipt", sourceId="shipping",originalSha256=LabelHash,
                    mediaType="application/zpl",bytesBase64=Convert.ToBase64String(Label)});
            else
            {
                Assert.StartsWith("/v1/partner/agent/order-proofs/cloudOrder/revisions/",path);
                var revision=int.Parse(path.Split('/')[^1]);
                result=Json.Element(new{proofId="cloudOrder",orderReference="SO10482",revision,lines=new[]{new{lineId="20",orderedQuantity=2}},events=Array.Empty<object>(),evidence=Array.Empty<object>(),originalArtifacts=revision==2?new[]{Link}:Array.Empty<object>()});
            }
            var response=new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(result.GetRawText())};
            response.Headers.Date=DateTimeOffset.UtcNow;
            return response;
        }
    }

    [Fact]
    public async Task LostDestinationPreservesCloudRevisionJobAndResumesFromProtectedCheckpoint()
    {
        var store=new ProtectedStore(Path.Combine(root,"service"),new Protector());
        store.Initialize();
        var host=new HostConfiguration("development","https://api.example","https://app.example","S-1-5-21-1-2-3-1001");
        var output=Directory.CreateDirectory(Path.Combine(root,"out")).FullName;
        var offline=Path.Combine(root,"unmounted");
        var state=new LocalState{Token="owned-installation",InstallationId="install",CredentialExpiresAt=DateTimeOffset.UtcNow.AddDays(1)};
        var hash=Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(output.ToUpperInvariant())));
        state.Workspace=new(){Phase="active",ActiveGrant=new("install","scope",hash,[],DateTimeOffset.UtcNow,3600)};
        async Task Run(Server server,bool first=false)
        {
            using var runtime=new AgentRuntime(host,store,new PackProofClient(host,server),state);
            if(first)runtime.ConfigureProofOutput(output,[]);
            await runtime.TickProofOutput(default);
        }
        await Run(new(),true);
        var pointers=Directory.GetFiles(output,"current.html",SearchOption.AllDirectories);
        Assert.Single(pointers);
        Assert.Contains("revision-00000001",File.ReadAllText(pointers[0]));
        Directory.Move(output,offline);
        state=store.Read<LocalState>("state.bin")!;
        await Run(new Server{Revision=2});
        var interrupted=store.Read<LocalState>("state.bin")!;
        Assert.Equal(2,interrupted.ProofOutput!.Cursor);
        Assert.Equal(1,interrupted.ProofOutput.CompletedRevision);
        Assert.Equal(2,Assert.Single(interrupted.ProofOutput.Jobs).Revision);
        Directory.Move(offline,output);
        Assert.Contains("revision-00000001",File.ReadAllText(pointers[0]));
        state=interrupted;
        state.ProofOutput.Jobs[0].NextAttemptAt=DateTimeOffset.UtcNow.AddSeconds(-1);
        await Run(new Server{Revision=2});
        var restored=store.Read<LocalState>("state.bin")!.ProofOutput!;
        Assert.Empty(restored.Jobs);
        Assert.Equal(2,restored.CompletedRevision);
        Assert.Contains("revision-00000002",File.ReadAllText(pointers[0]));
        var linked=Directory.GetFiles(output,"*.zpl",SearchOption.AllDirectories);
        Assert.Equal(Server.Label,File.ReadAllBytes(Assert.Single(linked)));
    }

    public void Dispose(){SqliteConnection.ClearAllPools();Directory.Delete(root,true);}
}
