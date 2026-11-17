using System.Threading.Channels;
using System.Diagnostics;

namespace PackProof.Connect;

public sealed partial class AgentRuntime
{
    private readonly Channel<bool> serviceWake = Channel.CreateBounded<bool>(new BoundedChannelOptions(1) {
        FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true, SingleWriter = false
    });
    private void WakeService() => serviceWake.Writer.TryWrite(true);

    public async Task RunTickLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var start = Stopwatch.GetTimestamp();
            await Tick(ct);
            // Bound callback storms and repeated network work even under continuous writes.
            var debounce = TimeSpan.FromMilliseconds(200) - Stopwatch.GetElapsedTime(start);
            if (debounce > TimeSpan.Zero) await Task.Delay(debounce,ct);
            var active = state.Workspace?.Phase is "active" or "awaiting_approval" || state.Workspace?.ActiveGrant != null;
            using var period = CancellationTokenSource.CreateLinkedTokenSource(ct);
            period.CancelAfter(TimeSpan.FromSeconds(active ? 1 : 5));
            try { await serviceWake.Reader.ReadAsync(period.Token); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
        }
    }
}

