using System.Net;
using PackProof.Connect;
using Xunit;
namespace PackProof.Connect.Tests;
public sealed class ClockObservationTests
{
    private static HostConfiguration Host() => new("development", "https://api.example", "https://app.example", "S-1-5-21-1-2-3-1001");
    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Utc = DateTimeOffset.Parse("2026-11-13T12:00:00Z");
        public long Ticks;
        public override DateTimeOffset GetUtcNow() => Utc;
        public override long GetTimestamp() => Ticks;
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public void Advance(TimeSpan elapsed) { Utc += elapsed; Ticks += elapsed.Ticks; }
    }
    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> response) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => Task.FromResult(response(request));
    }
    private static HttpResponseMessage Reply(DateTimeOffset? date)
    { var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}") }; response.Headers.Date = date; return response; }
    [Theory][InlineData(6)][InlineData(20)][InlineData(120)][InlineData(1440)]
    public async Task Waiting_in_setup_does_not_become_clock_drift(int minutes)
    {
        var clock = new Clock(); using var client = new PackProofClient(Host(), new Handler(_ => Reply(clock.Utc)), clock);
        await client.Request("GET", "/health", null, null, null, default); clock.Advance(TimeSpan.FromMinutes(minutes));
        Assert.Equal(clock.Utc, client.LastServerDate); Assert.True(client.LastResponseHadServerDate);
    }
    [Theory][InlineData(-10)][InlineData(10)]
    public async Task A_real_wall_clock_edit_is_not_hidden_by_elapsed_time(int minutes)
    {
        var clock = new Clock(); using var client = new PackProofClient(Host(), new Handler(_ => Reply(clock.Utc)), clock);
        await client.Request("GET", "/health", null, null, null, default); clock.Advance(TimeSpan.FromMinutes(20)); clock.Utc += TimeSpan.FromMinutes(minutes);
        Assert.True(Math.Abs((clock.Utc - client.LastServerDate!.Value).TotalMinutes) > 5);
    }
    [Fact] public async Task Missing_header_does_not_erase_a_known_skew()
    {
        var clock = new Clock(); var calls = 0; using var client = new PackProofClient(Host(), new Handler(_ => Reply(++calls == 1 ? clock.Utc.AddMinutes(-10) : null)), clock);
        await client.Request("GET", "/health", null, null, null, default); clock.Advance(TimeSpan.FromMinutes(20));
        await client.Request("GET", "/health", null, null, null, default);
        Assert.False(client.LastResponseHadServerDate); Assert.Equal(TimeSpan.FromMinutes(10), clock.Utc - client.LastServerDate!.Value);
    }
    [Fact] public async Task No_server_date_is_not_a_successful_clock_observation()
    {
        var clock = new Clock(); using var client = new PackProofClient(Host(), new Handler(_ => Reply(null)), clock);
        await client.Request("GET", "/health", null, null, null, default); Assert.Null(client.LastServerDate); Assert.False(client.LastResponseHadServerDate);
    }
    [Fact] public async Task Fresh_header_replaces_the_previous_observation()
    {
        var clock = new Clock(); var date = clock.Utc.AddMinutes(-10); using var client = new PackProofClient(Host(), new Handler(_ => Reply(date)), clock);
        await client.Request("GET", "/health", null, null, null, default); clock.Advance(TimeSpan.FromMinutes(20)); date = clock.Utc;
        await client.Request("GET", "/health", null, null, null, default); clock.Advance(TimeSpan.FromMinutes(8)); Assert.Equal(clock.Utc, client.LastServerDate);
    }
}
