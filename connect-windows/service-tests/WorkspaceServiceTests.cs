using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using PackProof.Connect;
using Xunit;

public sealed class WorkspaceServiceTests
{
    private sealed class ReceiptClock(DateTimeOffset seen) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = seen;
        public override DateTimeOffset GetUtcNow() => Now;
    }
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
    public async Task Restart_preserves_new_CSV_setup_and_only_migrates_existing_folders_once()
    {
        if (!OperatingSystem.IsWindows()) return;
        var root = Directory.CreateTempSubdirectory("pp-workspace-upgrade-").FullName;
        var folder = Directory.CreateDirectory(Path.Combine(root,"csv")).FullName;
        var orders = Directory.CreateDirectory(Path.Combine(root,"orders")).FullName;
        var store = new ProtectedStore(Path.Combine(root,"store"),new TestProtector());
        store.Initialize();
        var host = new HostConfiguration("development","https://api.example","https://portal.example","S-1-5-32-545");
        AgentRuntime Open(LocalState s) => new(host,store,new PackProofClient(host,new WorkspaceServer()),s);
        byte[] Persisted() => File.ReadAllBytes(Path.Combine(store.Root,"state.bin"));
        static JsonElement Data(object value) => Json.Element(value);
        try
        {
            using (var app = Open(new()))
                await app.Command("selectFolder",Data(new {folder}),default);
            var before = Persisted();
            using (var app = Open(store.Read<LocalState>("state.bin")!))
            {
                await app.Tick(default);
                var status = Data(await app.Command("status",null,default));
                Assert.Equal(folder,status.GetProperty("source").GetProperty("folder").GetString());
                Assert.Empty(status.GetProperty("workspace").GetProperty("sources").EnumerateArray());
                Assert.Equal(before,Persisted());
                var draft = Data(await app.Command("addWorkspaceSource",Data(new{folder=orders,role="order"}),default));
                Assert.Single(draft.GetProperty("workspace").GetProperty("sources").EnumerateArray());
            }

            // An installation from before the migration marker can contain
            // partially completed source setup. Preserve that identity and folder.
            var legacy = new LocalState { Folder = folder };
            SourceStateMigration.SynchronizeLegacy(legacy);
            store.Write("state.bin",legacy);
            using (Open(legacy)) { }
            var migrated = store.Read<LocalState>("state.bin")!;
            Assert.Single(migrated.Workspace!.Sources);
            Assert.Equal(folder,migrated.Workspace.Sources[0].Folder);
            Assert.Equal(SourceSubscriptionState.LegacyId,migrated.Workspace.Sources[0].Id);
            before = Persisted();
            using (Open(migrated)) { }
            Assert.Equal(before,Persisted());
        }
        finally { SqliteConnection.ClearAllPools(); Directory.Delete(root,recursive:true); }
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
        var firstSeen=DateTimeOffset.Parse("2026-11-19T19:34:00Z",System.Globalization.CultureInfo.InvariantCulture);
        var clock=new ReceiptClock(firstSeen);
        AgentRuntime Open(LocalState s) => new(host,store,new PackProofClient(host,api),s,receiptClock:clock);
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
                api.ServesWorkspace = false;
                var unavailable = await Assert.ThrowsAsync<ConnectException>(() => app.Command("activateWorkspace",Data(new {}),default));
                Assert.Equal("WORKSPACE_NOT_AVAILABLE",unavailable.Code);
                api.ServesWorkspace = true;
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
            clock.Now=firstSeen.AddHours(1);
            using (var app = Open(store.Read<LocalState>("state.bin")!))
            {
                await app.Tick(default); // reconnect, same scope, durable request survives restart
                Assert.Single(api.Uploads);
                var body = api.Uploads.Single();
                Assert.Equal(firstSeen,body.GetProperty("firstSeenAt").GetDateTimeOffset());
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

    [Fact]
    public async Task Capacity_failure_preserves_checkpoint_and_cold_restore_resumes_exact_work()
    {
        if (!OperatingSystem.IsWindows()) return;
        var root = Directory.CreateTempSubdirectory("pp-workspace-recovery-").FullName;
        var folder = Directory.CreateDirectory(Path.Combine(root, "input")).FullName;
        var output = Directory.CreateDirectory(Path.Combine(root, "output")).FullName;
        var snapshot = Path.Combine(root, "backup");
        var store = new ProtectedStore(Path.Combine(root,"original"),new TestProtector());
        store.Initialize();
        var host = new HostConfiguration("development","https://api.example","https://portal.example","S-1-5-32-545");
        var api = new WorkspaceServer { Active = true };
        var original = new LocalState { InstallationId = "recovery-fixture", Token = "fixture", CredentialExpiresAt = DateTimeOffset.UtcNow.AddDays(40) };
        var started = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            using (var app = new AgentRuntime(host, store, new(host,api),original,queueFileLimit:1))
            {
                await app.Command("addWorkspaceSource",Json.Element(new {folder,role="order"}),default);
                await app.Command("setWorkspaceOutput",Json.Element(new { folder = output }), default);
                await app.Command("activateWorkspace",Json.Element(new{}),default);
                foreach (var id in new[] { "A", "B" })
                    await File.WriteAllBytesAsync(Path.Combine(folder,id+".json"), Json.Bytes(new { eventId=id,version="1",kind="order",entityNamespace="erp",entityType="order",entityId=id }));
                await app.Tick(default);
                var retained = store.Read<LocalState>("state.bin")!;
                Assert.Equal("SPOOL_CAPACITY_REACHED",retained.Workspace!.Sources.Single().Issue);
                Assert.Equal(1,retained.Workspace.Sources.Single().Inventory.Count);
                Assert.Empty(api.Uploads);
                await app.Command("checkpoint",null,default);
            }
            // Copy a closed, checkpointed store including protected state, SQLite, spool key and payloads.
            // A running service must never share a writable data root with its restored copy.
            CopyTree(store.Root,snapshot);
            var restoreTime = System.Diagnostics.Stopwatch.StartNew();
            var restored = new ProtectedStore(Path.Combine(root,"restored"),new TestProtector());
            CopyTree(snapshot,restored.Root);
            var reloaded = restored.Read<LocalState>("state.bin")!;
            Assert.Equal(SourceStateMigration.ActiveWorkspaceVersion,reloaded.StateVersion);
            var retainedJob = reloaded.Workspace!.Sources.Single().Inventory.Single().Value;
            Assert.Equal(1L,retainedJob.Sequence);
            Assert.Equal(store.Read<LocalState>("state.bin")!.ProofOutput!.Writer,reloaded.ProofOutput!.Writer);
            Assert.Equal(store.Read<LocalState>("state.bin")!.ProofOutput!.Cursor,reloaded.ProofOutput.Cursor);
            using (var verified = new DurableQueue(restored))
            {
                var entry = verified.Entries().Single();
                Assert.Equal(retainedJob.Digest,entry.Digest);
                Assert.Equal("A.json",verified.Payload(entry).FileName);
            }
            var recoveryMillis = restoreTime.ElapsedMilliseconds;
            // Simulate the next scheduled retry without waiting ten seconds.
            reloaded.Workspace.Sources.Single().RetryAt = DateTimeOffset.MinValue;
            using (var app = new AgentRuntime(host,restored,new(host,api),reloaded))
            {
                await app.Tick(default);
                await app.Tick(default);
                Assert.Equal(2,api.Uploads.Count);
                Assert.Equal(2,api.Uploads.Select(p=>p.GetProperty("observationId").GetString()).Distinct().Count());
                Assert.Equal(2,restored.Read<LocalState>("state.bin")!.Workspace!.Sources.Single().Inventory.Count);
            }
            Console.WriteLine($"Windows cold restore of one captured observation + one replayable file: {recoveryMillis} ms to verified state, {started.ElapsedMilliseconds} ms total, 0 lost captured observations.");
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(root,recursive:true);
        }
    }

    private static void CopyTree(string source,string destination)
    {
        Directory.CreateDirectory(destination);
        foreach(var path in Directory.EnumerateFiles(source)) File.Copy(path,Path.Combine(destination,Path.GetFileName(path)));
        foreach(var child in Directory.EnumerateDirectories(source)) CopyTree(child,Path.Combine(destination,Path.GetFileName(child)));
    }

    private sealed class TestProtector : ISecretProtector
    {
        // Distinguish a needless rewrite of unchanged plaintext from keeping the
        // original persisted bytes, as CurrentUser DPAPI does on the installed service.
        public byte[] Protect(byte[] value) => [.. Guid.NewGuid().ToByteArray(), .. value];
        public byte[] Unprotect(byte[] value) => value[16..];
    }
    private sealed class WorkspaceServer : HttpMessageHandler
    {
        internal bool Active { get; set; }
        internal bool ServesWorkspace { get; set; } = true;
        internal List<JsonElement> Uploads { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req,CancellationToken ct)
        {
            var path = req.RequestUri!.AbsolutePath;
            if (!ServesWorkspace && path.EndsWith("/order-workspace/proposals",StringComparison.Ordinal))
                return new HttpResponseMessage(HttpStatusCode.NotFound) { Content = new StringContent("{}") };
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

