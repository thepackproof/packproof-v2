using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PackProof.Connect;

if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("PackProof Connect requires Windows 11 x64.");
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
        var bridge = pipe.Run(stoppingToken);
        var installationHealth = readiness.Run(stoppingToken);
        try
        {
            using var ticks = new PeriodicTimer(TimeSpan.FromSeconds(5));
            while (await ticks.WaitForNextTickAsync(stoppingToken))
            {
                await agent.Tick(stoppingToken);
                if (bridge.IsFaulted) await bridge;
                if (installationHealth.IsFaulted) await installationHealth;
            }
        }
        finally { try { await Task.WhenAll(bridge, installationHealth); } catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { } }
    }
}
