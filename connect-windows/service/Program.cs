using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PackProof.Connect;

if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("PackProof Connect requires Windows 11 x64.");
if (args is ["--read-source-media", var extension]) { Environment.ExitCode = await SourceReaders.RunMediaChild(extension, CancellationToken.None); return; }
var path = Path.Combine(AppContext.BaseDirectory, "service-config.json");
var configuration = Json.Read<HostConfiguration>(File.ReadAllBytes(path)); configuration.Validate();
var builder = Host.CreateApplicationBuilder(args); builder.Logging.ClearProviders();
builder.Services.Configure<HostOptions>(o => o.ShutdownTimeout = TimeSpan.FromSeconds(40));
builder.Services.AddWindowsService(options => options.ServiceName = configuration.ServiceName);
builder.Services.AddSingleton(configuration); builder.Services.AddSingleton<AgentRuntime>(); builder.Services.AddSingleton<PipeServer>(); builder.Services.AddSingleton<InstallerReadiness>(); builder.Services.AddHostedService<CollectionWorker>();
await builder.Build().RunAsync();

sealed class CollectionWorker(AgentRuntime agent, PipeServer pipe, InstallerReadiness readiness) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        var bridge = pipe.Run(lifetime.Token);
        var installationHealth = readiness.Run(lifetime.Token);
        var collection = agent.RunTickLoop(lifetime.Token);
        try { await await Task.WhenAny(collection, bridge, installationHealth); }
        finally
        {
            await lifetime.CancelAsync();
            try { await Task.WhenAll(bridge, installationHealth, collection); }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        }
    }
}
