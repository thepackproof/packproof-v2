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
        AgentRuntime Open()=>new(host,store,new PackProofClient(host,Connect(api,pipe)),state);
        using var timeout=new CancellationTokenSource(TimeSpan.FromMinutes(5));
        var ct=timeout.Token;
        using(var setup=Open())
        {
            foreach(var role in new[]{"order","picking","packing","shipping","handoff","delivery","evidence","returns"})
            {
                var folder=Path.Combine(root,role);
                if(role is "returns" or "evidence" && !Directory.Exists(folder))continue;
                Directory.CreateDirectory(folder);
                await setup.Command("addWorkspaceSource",Json.Element(new{folder,role}),ct);
            }
            var output=Directory.CreateDirectory(Path.Combine(root,"output")).FullName;
            await setup.Command("setWorkspaceOutput",Json.Element(new{folder=output}),ct);
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
                sources=state.Workspace.Sources.Select(s=>new{s.Id,role=s.Roles.FirstOrDefault(),s.Generation})});
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
