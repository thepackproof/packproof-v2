using System.Net;
using System.Runtime.CompilerServices;
using Microsoft.Data.Sqlite;
using PackProof.Connect;
using Xunit;

public sealed class LocalInitializationReadinessTests : IDisposable
{
    private readonly string root=Path.Combine(Path.GetTempPath(),"connect-local-admission-"+Guid.NewGuid().ToString("N"));
    private static HostConfiguration Host()=>new("development","https://api.example","https://app.example","S-1-5-21-1-2-3-1001");
    private sealed class PlainProtector:ISecretProtector {public byte[] Protect(byte[] value)=>value.ToArray();public byte[] Unprotect(byte[] value)=>value.ToArray();}
    private sealed class BlockedHeartbeat:HttpMessageHandler
    {
        public TaskCompletionSource Entered {get;}=new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int Attempts {get;private set;}
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)
        {
            Attempts++;Assert.Equal(HttpMethod.Post,request.Method);Assert.Equal("/v1/partner/agent/heartbeat",request.RequestUri!.AbsolutePath);Assert.Equal("Bearer",request.Headers.Authorization?.Scheme);
            Entered.TrySetResult();await Task.Delay(Timeout.InfiniteTimeSpan,ct);
            throw new HttpRequestException("Synthetic unreachable heartbeat");
        }
    }
    [Fact]
    public async Task Reenrolled_runtime_local_admission_does_not_wait_for_cloud_work_holding_the_command_gate()
    {
        var store=new ProtectedStore(root,new PlainProtector());store.Initialize();
        var state=new LocalState{Token="synthetic-enrolled-token",InstallationId="installation-synthetic",CredentialExpiresAt=DateTimeOffset.UtcNow.AddDays(30),LocalPaused=true};
        store.Write("state.bin",state);
        var transport=new BlockedHeartbeat();
        using var runtime=new AgentRuntime(Host(),store,new PackProofClient(Host(),transport),state);
        var keyBefore=File.ReadAllBytes(Path.Combine(root,"spool-key.bin"));var stateBefore=File.ReadAllBytes(Path.Combine(root,"state.bin"));
        using var stop=new CancellationTokenSource();var tick=runtime.Tick(stop.Token);
        try
        {
            await transport.Entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
            using var statusDeadline=new CancellationTokenSource(TimeSpan.FromMilliseconds(150));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(()=>runtime.Command("status",null,statusDeadline.Token));
            // This is the same immutable admission guard used by InstallerReadiness.
            // Ordinary status is blocked above, proving the network gate is held.
            // Native suites run in parallel; a queued ThreadPool work item can
            // be starved independently of this synchronous local guard. Use a
            // dedicated thread while staying below the pipe's 10-second deadline.
            await Task.Factory.StartNew(runtime.RequireLocalInitialization,CancellationToken.None,TaskCreationOptions.LongRunning,TaskScheduler.Default).WaitAsync(TimeSpan.FromSeconds(3));
            Assert.False(tick.IsCompleted);Assert.Equal(1,transport.Attempts);Assert.True(state.LocalPaused);
            Assert.Equal(keyBefore,File.ReadAllBytes(Path.Combine(root,"spool-key.bin")));
            Assert.Equal(stateBefore,File.ReadAllBytes(Path.Combine(root,"state.bin")));
            Assert.Empty(Directory.EnumerateFiles(Path.Combine(root,"spool")));
        }
        finally {stop.Cancel();await tick.WaitAsync(TimeSpan.FromSeconds(3));}
    }
    [Fact]
    public void Local_admission_cannot_report_ready_without_completed_constructor_initialization()
    {
        var notStarted=(AgentRuntime)RuntimeHelpers.GetUninitializedObject(typeof(AgentRuntime));
        Assert.Equal("SERVICE_NOT_READY",Assert.Throws<ConnectException>(notStarted.RequireLocalInitialization).Code);
    }
    public void Dispose()
    {
        using var connection=new SqliteConnection(new SqliteConnectionStringBuilder{DataSource=Path.Combine(root,"queue.sqlite"),Mode=SqliteOpenMode.ReadWriteCreate}.ToString());SqliteConnection.ClearPool(connection);
        if(Directory.Exists(root))Directory.Delete(root,true);
    }
}
