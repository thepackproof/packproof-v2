using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using PackProof.Connect;
using Xunit;

public sealed class DesktopProofTests
{
    [Fact]
    public void Full_detail_keeps_all_line_allocations_and_exact_event_identity_while_raw_fields_require_inspection()
    {
        var allocation=new {lineId="10",unit="EA",loadedQuantity="8",acknowledgedQuantity="6"};
        var row=new {
            eventKey="e1",receiptId="r1",kind="handoff",version="3",associationScope="order",
            entity=new {type="delivery",id="D1",@namespace="Dock"},
            references=new[]{new{type="shipment",id="S1",@namespace="Dispatch"},new{type="package",id="P2",@namespace="Packing"}},
            lines=new[]{allocation},fields=new{customerName="Riverside",PrivateSourceColumn="inspector only"}
        };
        var result=Json.Element(AgentRuntime.OrderForDesktop(Json.Element(new{
            proofId="P1",revision=6,orderReference="SO22",lines=new[]{allocation},events=Enumerable.Repeat(row,130),
            evidence=new[]{new {eventKey="e1",locator="row 4",fields=new {PrivateSourceColumn="inspector only"}}}
        })));
        Assert.Equal(130,result.GetProperty("events").GetArrayLength());
        var first=result.GetProperty("events")[0];
        Assert.Equal("8",first.GetProperty("lines")[0].GetProperty("loadedQuantity").GetString());
        Assert.Equal("S1",first.GetProperty("references")[0].GetProperty("id").GetString());
        Assert.Equal("P2",result.GetProperty("packages")[0].GetProperty("packageId").GetString());
        Assert.DoesNotContain("PrivateSourceColumn",result.GetRawText());
        Assert.Equal("e1",result.GetProperty("evidence")[0].GetProperty("eventKey").GetString());
    }

    [Fact]
    public void Operational_columns_are_explicit_and_a_signature_alone_has_no_line_quantity()
    {
        var peers=new Dictionary<string,string>{{"order","sales"},{"shipping","dock"}};
        static SourceReadResult Csv(string csv)=>SourceReaders.Read("report.csv",Encoding.UTF8.GetBytes(csv));
        JsonElement Line(string text,string role,string source){
            var report=Csv(text);
            var map=SourceReaders.ProposeWorkflowMap(report,role,source,peers)!;
            return SourceReaders.NormalizeWorkflow(report,source,map)[0].GetProperty("lines")[0];
        }
        Assert.Equal("6",Line("DeliveryID,ShipmentNumber,OrderLineID,QtyReceived,UOM,DeliveredAt\nD1,S1,10,6,EA,2026-11-17T12:00:00Z","delivery","receiving").GetProperty("acknowledgedQuantity").GetString());
        Assert.False(Line("DeliveryID,ShipmentNumber,OrderLineID,UOM,DeliveredAt\nD1,S1,10,EA,2026-11-17T12:00:00Z","delivery","receiving").TryGetProperty("acknowledgedQuantity",out _));
        var load=Line("ShipmentNumber,OrderNumber,OrderLineID,QtyLoaded,UOM,Version\nS1,O1,10,8,EA,2","shipping","dock");
        Assert.Equal("8",load.GetProperty("loadedQuantity").GetString());
        Assert.False(load.TryGetProperty("shippedQuantity",out _));
        var deferred=Csv("OrderNumber,OrderLineID,OrderedQty,BackorderedQty,UOM,Version\nO1,30,2,2,EA,1");
        Assert.Equal("2",SourceReaders.NormalizeOrderLines(deferred,"sales",SourceReaders.ProposeOrderMap(deferred)!)[0].GetProperty("lines")[0].GetProperty("backorderedQuantity").GetString());
    }

    private sealed class TestProtector:ISecretProtector
    {
        public byte[] Protect(byte[] bytes)=>bytes.ToArray();
        public byte[] Unprotect(byte[] bytes)=>bytes.ToArray();
    }
    private sealed class SourceServer:HttpMessageHandler
    {
        public readonly List<string> Paths=[];
        public bool WrongDigest;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)
        {
            Assert.Equal("installation-token",request.Headers.Authorization?.Parameter);
            var path=request.RequestUri!.AbsolutePath;Paths.Add(path);
            var bytes=Encoding.UTF8.GetBytes("^XA^FDorder^FS^XZ");
            object value=path switch{
                "/v1/partner/agent/order-proofs/P1/revisions/6/sources/E1"=>new {kind="derived_excerpt",eventKey="E1",receiptId="r1",fileName="sidecar.json",
                    fields=new{quantity="8"},reason="record_excerpt",artifactReceiptId="a1",unexpectedProperty=1},
                "/v1/partner/agent/order-proofs/P1/revisions/6/artifacts/a1"=>new {kind="original",receiptId="a1",fileName="label.zpl",mediaType="application/zpl",
                    originalSha256=WrongDigest?new string('0',64):Convert.ToHexStringLower(SHA256.HashData(bytes)),bytesBase64=Convert.ToBase64String(bytes)},
                _=>throw new InvalidOperationException(path)};
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(Json.Bytes(value))});
        }
    }
    [Fact]
    public async Task Original_is_bound_to_its_event_revision_attachment_digest_and_current_grant()
    {
        var root=Directory.CreateTempSubdirectory().FullName;
        try{
            var store=new ProtectedStore(root,new TestProtector());store.Initialize();
            var host=new HostConfiguration("development","https://api.example","https://app.example","S-1-5-32-545");
            var state=new LocalState{Token="installation-token",InstallationId="i1",CredentialExpiresAt=DateTimeOffset.UtcNow.AddDays(1)};
            state.Workspace=new(){Phase="active",ActiveGrant=new("i1","scope","dest",[],DateTimeOffset.UtcNow,3600)};
            var server=new SourceServer();
            using var rt=new AgentRuntime(host,store,new PackProofClient(host,server),state);
            var query=Json.Element(new{proofId="P1",revision=6,eventKey="E1"});
            var result=Json.Element(await rt.Command("workspaceSourceRecord",query,default));
            Assert.Equal("r1",result.GetProperty("receiptId").GetString());
            Assert.Equal("a1",result.GetProperty("artifact").GetProperty("receiptId").GetString());
            Assert.False(result.TryGetProperty("unexpectedProperty",out _));
            server.WrongDigest=true;
            await Assert.ThrowsAsync<ConnectException>(()=>rt.Command("workspaceSourceRecord",query,default));
            state.Workspace.ActiveGrant=null;
            Assert.Equal("AUTH_REQUIRED",(await Assert.ThrowsAsync<ConnectException>(()=>rt.Command("workspaceSourceRecord",query,default))).Code);
            Assert.Equal(4,server.Paths.Count);
        }finally{SqliteConnection.ClearAllPools();Directory.Delete(root,true);}
    }

    [Fact]
    public async Task Windows_folder_replacement_preserves_roles_and_requires_approval_for_new_scope()
    {
        if(!OperatingSystem.IsWindows())return;
        var root=Directory.CreateTempSubdirectory().FullName;
        try{
            var a=Directory.CreateDirectory(Path.Combine(root,"old")).FullName;
            var b=Directory.CreateDirectory(Path.Combine(root,"new")).FullName;
            var store=new ProtectedStore(Path.Combine(root,"state"),new TestProtector());store.Initialize();
            var host=new HostConfiguration("development","https://api.example","https://app.example","S-1-5-32-545");
            using var rt=new AgentRuntime(host,store,new PackProofClient(host,new SourceServer()),new LocalState());
            await rt.Command("addWorkspaceSource",Json.Element(new{role="order",folder=a}),default);
            var added=Json.Element(await rt.Command("addWorkspaceSource",Json.Element(new{role="shipping",folder=a}),default));
            var src=added.GetProperty("workspace").GetProperty("sources")[0];
            var sourceId=src.GetProperty("id").GetString();var expectedGeneration=src.GetProperty("generation").GetInt32();
            var same=Json.Element(await rt.Command("replaceWorkspaceFolder",Json.Element(new{sourceId,expectedGeneration,folder=a}),default));
            Assert.Equal(expectedGeneration,same.GetProperty("workspace").GetProperty("sources")[0].GetProperty("generation").GetInt32());
            var moved=Json.Element(await rt.Command("replaceWorkspaceFolder",Json.Element(new{sourceId,expectedGeneration,folder=b}),default)).GetProperty("workspace");
            var source=moved.GetProperty("sources")[0];
            Assert.Equal("draft",moved.GetProperty("phase").GetString());
            Assert.Equal(sourceId,source.GetProperty("id").GetString());
            Assert.Equal(expectedGeneration+1,source.GetProperty("generation").GetInt32());
            Assert.Equal(2,source.GetProperty("roles").GetArrayLength());
            Assert.Equal(b,source.GetProperty("folder").GetString());
            await Assert.ThrowsAsync<ConnectException>(()=>rt.Command("replaceWorkspaceFolder",Json.Element(new{sourceId,expectedGeneration,folder=a}),default));
        }finally{SqliteConnection.ClearAllPools();Directory.Delete(root,true);}
    }
}
