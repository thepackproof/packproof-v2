using System.IO.Pipes;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using PackProof.Connect;
using Xunit;

// Invoked by the isolated HTTP scenario. The runtime and both databases use
// their normal contracts; only enrollment bootstrap, local secret protection
// and the loopback transport endpoint are specific to this fixture.
public sealed class ControlledHttpJourneyTests
{
    private sealed class DispatchClock(string root) : TimeProvider
    {
        private readonly JsonElement times=Json.Read<JsonElement>(File.ReadAllBytes(Path.Combine(root,"expectations.json"))).GetProperty("clock");
        public override DateTimeOffset GetUtcNow()
        {
            var key=File.Exists(Path.Combine(root,"dispatch-restored"))?"recovery":
                File.Exists(Path.Combine(root,"inspect-outage"))?"inspect":"lastDispatchRead";
            return times.GetProperty(key).GetDateTimeOffset().ToUniversalTime();
        }
    }

    private static async Task ConfigureReference(AgentRuntime setup, string root, CancellationToken ct)
    {
        await setup.Command("refresh",null,ct);
        string? labelSource=null, deliverySource=null;
        foreach (var role in new[] {"order","packing","shipping","delivery"})
        {
            var folder=Path.Combine(root,role);
            var status=Json.Element(await setup.Command("addWorkspaceSource", Json.Element(new {folder,role}),ct));
            var source=status.GetProperty("workspace").GetProperty("sources").EnumerateArray().Single(x=>x.GetProperty("folder").GetString()==folder);
            var id=source.GetProperty("id").GetString();
            await setup.Command("confirmWorkspaceOrderMap",Json.Element(new {sourceId=id,
                expectedGeneration=source.GetProperty("generation").GetInt32(),profileVersion=source.GetProperty("recognition").GetProperty("profileVersion").GetString()}),ct);
            if(role=="shipping")labelSource=id;
            if(role=="delivery")deliverySource=id;
        }
        var draft=Json.Element(await setup.Command("getFacilityDraft",Json.Element(new {}),ct));
        var expected=Json.Read<JsonElement>(File.ReadAllBytes(Path.Combine(root,"expectations.json")));
        var examples=new[]{"ordinary","split","reprint"}.Select(kind=>new {kind,reference=expected.GetProperty(kind).GetProperty("reference"),
            cartons=expected.GetProperty(kind).GetProperty("cartons"),labelCount=expected.GetProperty(kind).GetProperty("labels")}).ToArray();
        var saved=Json.Element(await setup.Command("saveFacilityDraft",Json.Element(new {expectedRevision=draft.GetProperty("revision"),
            changes=new {steps=draft.GetProperty("steps"),examples,rules=new[]{new {sourceId=labelSource,shippedAt="label"}},
                timing=new[]{new {sourceId=deliverySource,expectedCheckIntervalSeconds=300,expectedDeliveryAfterLabelSeconds=20700}},excludedSourceIds=Array.Empty<string>()}}),ct));
        var replay=Json.Element(await setup.Command("replayFacilityDraft",Json.Element(new {expectedRevision=saved.GetProperty("revision")}),ct));
        Assert.True(replay.GetProperty("replay").GetProperty("passed").GetBoolean(),replay.GetRawText());
    }
    private sealed class FixtureProtector : ISecretProtector
    {
        private readonly byte[] key=RandomNumberGenerator.GetBytes(32);
        public byte[] Protect(byte[] bytes)
        {
            var nonce=RandomNumberGenerator.GetBytes(12); var tag=new byte[16]; var cipher=new byte[bytes.Length];
            using var aes=new AesGcm(key,tag.Length);aes.Encrypt(nonce,bytes,cipher,tag);return [..nonce,..tag,..cipher];
        }
        public byte[] Unprotect(byte[] bytes)
        {
            var plain=new byte[bytes.Length-28];using var aes=new AesGcm(key,16);
            aes.Decrypt(bytes.AsSpan(0,12),bytes.AsSpan(28),bytes.AsSpan(12,16),plain);return plain;
        }
    }
    private sealed class Loopback(Uri api,HttpMessageHandler transport):DelegatingHandler(transport)
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)
        {
            request.RequestUri=new Uri(api,request.RequestUri!.PathAndQuery);
            return base.SendAsync(request,ct);
        }
    }
    private static HttpMessageHandler Connect(Uri api,string? pipe)
    {
        var sockets=new SocketsHttpHandler{UseProxy=false,AllowAutoRedirect=false};
        if(!string.IsNullOrEmpty(pipe))
        {
            if(pipe.Length>100||!pipe.All(c=>char.IsAsciiLetterOrDigit(c)||c is '_' or '-'))throw new ArgumentException("Invalid fixture pipe.");
            sockets.ConnectCallback=async (_,ct)=>{
                var stream=new NamedPipeClientStream(".",pipe,PipeDirection.InOut,PipeOptions.Asynchronous);
                try{await stream.ConnectAsync(ct);return stream;}catch{stream.Dispose();throw;}
            };
        }
        return new Loopback(api,sockets);
    }
    private static void Signal(string root,string name,object value)
    {
        var final=Path.Combine(root,name);var pending=final+"."+Guid.NewGuid().ToString("N");
        File.WriteAllBytes(pending,Json.Bytes(value));
        try
        {
            for (var attempt=0;;attempt++)
            {
                try { File.Move(pending,final,true); break; }
                catch(IOException) when(attempt<8) { Thread.Sleep(20); }
                catch(UnauthorizedAccessException) when(attempt<8) { Thread.Sleep(20); }
            }
        }
        finally { File.Delete(pending); }
    }

    [Fact]
    public async Task Run_real_order_service_against_isolated_http_application()
    {
        var url=Environment.GetEnvironmentVariable("PACKPROOF_JOURNEY_API");
        if(string.IsNullOrWhiteSpace(url))return;
        var api=new Uri(url);
        if(api.Scheme!="http" || !api.IsLoopback || api.UserInfo.Length>0)throw new ArgumentException("Use a loopback fixture endpoint.");
        var root=Environment.GetEnvironmentVariable("PACKPROOF_JOURNEY_ROOT") ?? throw new ArgumentException("Missing fixture root.");
        var installation=Environment.GetEnvironmentVariable("PACKPROOF_JOURNEY_INSTALLATION") ?? throw new ArgumentException("Missing fixture installation.");
        var token=Environment.GetEnvironmentVariable("PACKPROOF_JOURNEY_TOKEN") ?? throw new ArgumentException("Missing fixture enrollment.");
        var pipe=Environment.GetEnvironmentVariable("PACKPROOF_JOURNEY_PIPE");
        var store=new ProtectedStore(Path.Combine(root,"service-state"),new FixtureProtector());
        store.Initialize();
        var host=new HostConfiguration("development","https://local-api.example","https://local-web.example","S-1-5-32-545");
        var state=new LocalState{Token=token,InstallationId=installation,CredentialExpiresAt=DateTimeOffset.UtcNow.AddDays(30)};
        bool reference=Environment.GetEnvironmentVariable("PACKPROOF_JOURNEY_CARTONS")=="1";
        AgentRuntime Open()=>new(host,store,new PackProofClient(host,Connect(api,pipe)),state,receiptClock:reference?new DispatchClock(root):null);
        using var timeout=new CancellationTokenSource(TimeSpan.FromMinutes(5));
        var ct=timeout.Token;
        using(var setup=Open())
        {
            if (!reference) foreach(var role in new[]{"order","picking","packing","shipping","handoff","delivery","evidence","returns"})
            {
                var folder=Path.Combine(root,role);
                if(role is "returns" or "evidence" && !Directory.Exists(folder))continue;
                Directory.CreateDirectory(folder);
                await setup.Command("addWorkspaceSource",Json.Element(new{folder,role}),ct);
            }
            if (!reference) await setup.Command("addWorkspaceDirectSource",Json.Element(new {role="order",sourceNamespace="HTTP_FIXTURE_API"}),ct);
            var output=Directory.CreateDirectory(Path.Combine(root,"output")).FullName;
            await setup.Command("setWorkspaceOutput",Json.Element(new{folder=output}),ct);
            if (reference) await ConfigureReference(setup,root,ct);
            await setup.Command("saveWorkspaceStep",Json.Element(new{step="activate"}),ct);
        }
        state=store.Read<LocalState>("state.bin")!;
        var runtime=Open();bool restarted=false;
        var schedule=CancellationTokenSource.CreateLinkedTokenSource(ct);
        Task scheduler=Task.CompletedTask;
        async Task StopScheduler()
        {
            schedule.Cancel();
            try { await scheduler; }
            catch (OperationCanceledException) when(schedule.IsCancellationRequested) {}
            schedule.Dispose();
        }
        try
        {
            await runtime.Command("activateWorkspace",Json.Element(new{}),ct);
            var approval=new Uri(new Uri(host.WebOrigin),state.Workspace!.ApprovalPath!);
            var session=System.Web.HttpUtility.ParseQueryString(approval.Query)["workspaceSession"];
            if(string.IsNullOrEmpty(session) || state.Workspace.ScopeDigest is null)throw new Exception("No exact pending browser session.");
            Signal(root,"scope.json",new{sessionId=session,scopeDigest=state.Workspace.ScopeDigest,
                sources=state.Workspace.Sources.Select(s=>new{s.Id,s.Transport,role=s.Roles.FirstOrDefault(),s.Generation})});
            scheduler=runtime.RunTickLoop(schedule.Token);
            while(!File.Exists(Path.Combine(root,"done")))
            {
                if(!restarted && File.Exists(Path.Combine(root,"restart")))
                {
                    await StopScheduler();runtime.Dispose();state=store.Read<LocalState>("state.bin")!;runtime=Open();
                    schedule=CancellationTokenSource.CreateLinkedTokenSource(ct);scheduler=runtime.RunTickLoop(schedule.Token);
                    restarted=true;Signal(root,"restarted.json",new{resumed=true});
                }
                if(scheduler.IsFaulted) await scheduler;
                var status=Json.Element(await runtime.Command("status",null,ct));
                Signal(root,"service-status.json",new{restarted,at=DateTimeOffset.UtcNow,workspace=status.GetProperty("workspace"),
                    output=status.GetProperty("proofOutput"),lastError=state.LastErrorCode});
                await Task.Delay(200,ct);
            }
        }
        finally {await StopScheduler();runtime.Dispose();}
    }
}
