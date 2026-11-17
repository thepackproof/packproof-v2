using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using PackProof.Connect;
using Xunit;

public sealed class WorkspaceServiceTests
{
    [Fact]
    public void Shared_location_has_one_subscription_and_changed_roles_invalidate_the_submitted_generation()
    {
        var draft = new OrderWorkspaceState();
        var source = draft.Assign(@"C:\Orders", "order");
        draft.Phase = "active";
        Assert.Same(source,draft.Assign(@"c:\orders","order"));
        Assert.Equal("active",draft.Phase);
        Assert.Same(source,draft.Assign(@"c:\orders","picking"));
        Assert.Single(draft.Sources);
        Assert.Equal(2,source.Generation);
        Assert.Equal("draft",draft.Phase);
        draft.Assign(@"C:\Second","picking");
        Assert.Equal(2,draft.Sources.Count);
    }

    [Fact]
    public async Task Worker_persists_the_draft_captures_a_new_order_and_replays_the_same_bytes_after_restart()
    {
        if (!OperatingSystem.IsWindows()) return;
        var root = Directory.CreateTempSubdirectory("pp-workspace-test-").FullName;
        var folder = Directory.CreateDirectory(Path.Combine(root,"orders")).FullName;
        var output = Directory.CreateDirectory(Path.Combine(root,"saved")).FullName;
        var store = new ProtectedStore(Path.Combine(root,"store"),new TestProtector());
        store.Initialize();
        var api = new WorkspaceServer();
        var host = new HostConfiguration("development","https://api.example","https://portal.example","S-1-5-32-545");
        var initial = new LocalState { InstallationId = "test-device", Token = "test-token", CredentialExpiresAt = DateTimeOffset.UtcNow.AddDays(40) };
        AgentRuntime Open(LocalState s) => new(host,store,new PackProofClient(host,api),s);
        static JsonElement Data(object? data) => Json.Element(data);
        try
        {
            using (var app = Open(initial))
            {
                await app.Command("saveWorkspaceStep",Data(new { step = "picking" }),default);
                var status = Data(await app.Command("addWorkspaceSource",Data(new {folder,role="order"}),default));
                Assert.Equal("empty",status.GetProperty("workspace").GetProperty("sources")[0].GetProperty("recognition").GetProperty("state").GetString());
                await app.Command("addWorkspaceSource",Data(new {folder,role="picking"}),default);
                await app.Command("setWorkspaceOutput",Data(new {folder=output}),default);
                var overlap = await Assert.ThrowsAsync<ConnectException>(()=>app.Command("addWorkspaceSource",Data(new{folder=output,role="order"}),default));
                Assert.Equal("OUTPUT_PATH_UNSAFE",overlap.Code);
            }
            using (var app = Open(store.Read<LocalState>("state.bin")!))
            {
                var saved = Data(await app.Command("status",null,default)).GetProperty("workspace");
                Assert.Equal("picking",saved.GetProperty("step").GetString());
                Assert.Single(saved.GetProperty("sources").EnumerateArray());
                await app.Command("activateWorkspace",Data(new {}),default);
                var order = Data(new[] { new { eventId="order-1", version="1", kind="order", entityNamespace="ERP_A", entityType="order",entityId="SO10482" }});
                await File.WriteAllBytesAsync(Path.Combine(folder,"order.json"),Json.Bytes(order));
                await app.Tick(default); // pending approval never captures
                Assert.Empty(api.Uploads);
                api.Active = true;
            }
            using (var app = Open(store.Read<LocalState>("state.bin")!))
            {
                await app.Tick(default); // confirmed grant; stage the pre-existing order
            }
            using (var app = Open(store.Read<LocalState>("state.bin")!))
            {
                await app.Tick(default); // reconnect, same scope, durable request survives restart
                Assert.Single(api.Uploads);
                var body = api.Uploads.Single();
                Assert.Equal("SO10482", body.GetProperty("records")[0].GetProperty("entity").GetProperty("id").GetString());
                Assert.Equal(await File.ReadAllBytesAsync(Path.Combine(folder,"order.json")),Convert.FromBase64String(body.GetProperty("originalBase64").GetString()!));
                await app.Tick(default);
                Assert.Single(api.Uploads);
            }
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(root,recursive:true);
        }
    }

    private sealed class TestProtector : ISecretProtector
    {
        public byte[] Protect(byte[] value) => value.ToArray();
        public byte[] Unprotect(byte[] value) => value.ToArray();
    }
    private sealed class WorkspaceServer : HttpMessageHandler
    {
        internal bool Active { get; set; }
        internal List<JsonElement> Uploads { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req,CancellationToken ct)
        {
            var path = req.RequestUri!.AbsolutePath;
            var grant = new { state=Active?"active":"pending", scopeDigest=new string('a',64),offlineWindowSeconds=Active?3600:0,
                expiresAt=DateTimeOffset.UtcNow.AddMinutes(15),approvalPath="/app/records/connect/approve?workspace=test" };
            object response = path switch
            {
                "/v1/partner/agent/heartbeat" => new { state="ready", integrationAccountId="a", operatorMembershipId="m", sourceName="source",configRevision=0 },
                "/v1/partner/agent/order-workspace/proposals" or "/v1/partner/agent/order-workspace" => grant,
                "/v1/partner/agent/order-proofs" => new { orders=Array.Empty<object>(),cursor=0 },
                "/v1/partner/agent/order-changes" => new { changes=Array.Empty<object>(),nextCursor=0,hasMore=false },
                "/v1/partner/agent/order-workspace/observations" => Receive(Json.Read<JsonElement>(await req.Content!.ReadAsByteArrayAsync(ct))),
                _ => throw new InvalidOperationException(path)
            };
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(response,Json.Options),Encoding.UTF8,"application/json") };
        }
        private object Receive(JsonElement body)
        {
            Assert.True(Active);
            Uploads.Add(body);
            return new {state="accepted",receiptId="receipt",originalSha256=body.GetProperty("originalSha256"),proofs=Array.Empty<object>()};
        }
    }
}

