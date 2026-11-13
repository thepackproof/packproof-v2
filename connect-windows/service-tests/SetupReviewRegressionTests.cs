using System.Net;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using PackProof.Connect;
using Xunit;
namespace PackProof.Connect.Tests;
public sealed class SetupReviewRegressionTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "packproof-review-test-" + Guid.NewGuid().ToString("N"));
    private sealed class PlainProtector : ISecretProtector { public byte[] Protect(byte[] b) => b.ToArray(); public byte[] Unprotect(byte[] b) => b.ToArray(); }
    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => Task.FromResult(respond(request)); }
    private sealed class Clock : TimeProvider
    { public long Ticks; public override long GetTimestamp() => Ticks; public override long TimestampFrequency => TimeSpan.TicksPerSecond; }
    private static HostConfiguration Host() => new("development", "https://api.example", "https://app.example", "S-1-5-21-1-2-3-1001");
    public SetupReviewRegressionTests() => Directory.CreateDirectory(root);
    public void Dispose()
    {
        // Disposing a SQLite connection returns its handle to the pool. Release
        // only this fixture's pool before deleting its synthetic Windows files.
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(root, "queue.sqlite"), Mode = SqliteOpenMode.ReadWriteCreate }.ToString());
        SqliteConnection.ClearPool(connection);
        Directory.Delete(root, true);
    }
    private ProtectedStore Store() { var store = new ProtectedStore(root, new PlainProtector()); store.Initialize(); return store; }
    private static JsonElement Policy(object? proposal = null) => Json.Element(new { state = "needs_approval", config = (object?)null, configRevision = 0, pendingProposal = proposal, integrationAccountId = "integration", operatorMembershipId = "operator", sourceName = "Test CSV", locationId = (string?)null });
    private static HttpResponseMessage Response(JsonElement body, DateTimeOffset? date)
    { var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body.GetRawText()) }; response.Headers.Date = date; return response; }
    private static LocalState Enrolled(string? code = null) => new() { Token = "fake-test-secret", InstallationId = "installation-current", EnrollmentId = "enrollment-old", EnrollmentState = "credential", ApprovalPath = "/app/records/connect/approve?enrollmentId=enrollment-old", LocalPaused = true, LastErrorCode = code, LastPolicyCheckAt = DateTimeOffset.UtcNow.AddMinutes(-30), CredentialExpiresAt = DateTimeOffset.UtcNow.AddDays(10), PauseAuthorizationTimestamp = "2026-01-01T00:00:00Z" };
    [Fact] public async Task Healthy_refresh_clears_only_the_resolved_clock_warning_and_never_resumes()
    {
        var state = Enrolled("CLOCK_UNCERTAIN"); var store = Store();
        using var runtime = new AgentRuntime(Host(), store, new PackProofClient(Host(), new Handler(_ => Response(Policy(), DateTimeOffset.UtcNow))), state);
        var result = Json.Element(await runtime.Command("refresh", null, default));
        Assert.False(result.GetProperty("health").TryGetProperty("lastErrorCode", out _));
        var saved = store.Read<LocalState>("state.bin")!; Assert.Null(saved.LastErrorCode); Assert.True(saved.LocalPaused); Assert.Equal("2026-01-01T00:00:00Z", saved.PauseAuthorizationTimestamp); Assert.Equal("fake-test-secret", saved.Token);
    }
    [Fact] public async Task Clock_warning_is_not_cleared_without_fresh_server_time()
    {
        var state = Enrolled("CLOCK_UNCERTAIN"); using var runtime = new AgentRuntime(Host(), Store(), new PackProofClient(Host(), new Handler(_ => Response(Policy(), null))), state);
        await runtime.Command("refresh", null, default); Assert.Equal("CLOCK_UNCERTAIN", state.LastErrorCode); Assert.True(state.LocalPaused);
    }
    [Fact] public async Task Healthy_refresh_does_not_hide_an_unrelated_error()
    {
        var state = Enrolled("SPOOL_INTEGRITY_FAILED"); using var runtime = new AgentRuntime(Host(), Store(), new PackProofClient(Host(), new Handler(_ => Response(Policy(), DateTimeOffset.UtcNow))), state);
        await runtime.Command("refresh", null, default); Assert.Equal("SPOOL_INTEGRITY_FAILED", state.LastErrorCode);
    }
    [Fact] public async Task Twenty_minute_idle_reaches_heartbeat_instead_of_false_clock_failure()
    {
        var clock = new Clock(); var calls = 0;
        var client = new PackProofClient(Host(), new Handler(request => { calls++; return Response(Policy(), request.RequestUri!.AbsolutePath == "/health" ? DateTimeOffset.UtcNow.AddMinutes(-20) : DateTimeOffset.UtcNow); }), clock);
        await client.Request("GET", "/health", null, null, null, default); clock.Ticks += TimeSpan.FromMinutes(20).Ticks;
        var state = Enrolled("CLOCK_UNCERTAIN"); using var runtime = new AgentRuntime(Host(), Store(), client, state);
        await runtime.Command("refresh", null, default); Assert.Equal(2, calls); Assert.Null(state.LastErrorCode); Assert.True(state.LocalPaused);
    }
    [Fact] public async Task Genuine_server_skew_still_blocks_before_heartbeat()
    {
        var calls = 0; var client = new PackProofClient(Host(), new Handler(_ => { calls++; return Response(Policy(), DateTimeOffset.UtcNow.AddHours(-1)); }));
        await client.Request("GET", "/health", null, null, null, default);
        var state = Enrolled(); using var runtime = new AgentRuntime(Host(), Store(), client, state);
        Assert.Equal("CLOCK_UNCERTAIN", (await Assert.ThrowsAsync<ConnectException>(() => runtime.Command("refresh", null, default))).Code); Assert.Equal(1, calls); Assert.True(state.LocalPaused);
    }
    [Fact] public async Task Completed_enrollment_does_not_enable_configuration_review()
    {
        var state = Enrolled(); state.ServerConfig = Policy(); using var runtime = new AgentRuntime(Host(), Store(), new PackProofClient(Host(), new Handler(_ => throw new Exception("No network expected"))), state);
        var status = Json.Element(await runtime.Command("status", null, default));
        Assert.False(status.TryGetProperty("approvalPath", out _)); Assert.False(status.GetProperty("enrollment").TryGetProperty("approvalPath", out _));
        Assert.Equal("/app/records/connect/approve?enrollmentId=enrollment-old", state.ApprovalPath);
    }
    [Fact] public async Task Pending_configuration_enables_only_the_current_installation_review()
    {
        var state = Enrolled(); state.ServerConfig = Policy(new { folderDigest = "folder", sourceName = "Test CSV" }); using var runtime = new AgentRuntime(Host(), Store(), new PackProofClient(Host(), new Handler(_ => throw new Exception("No network expected"))), state);
        var status = Json.Element(await runtime.Command("status", null, default));
        Assert.Equal("/app/records/connect/approve?installationId=installation-current", status.GetProperty("approvalPath").GetString());
    }
    [Fact] public async Task Expired_pending_enrollment_has_no_review_link()
    {
        var state = new LocalState { EnrollmentId = "expired", EnrollmentState = "pending", EnrollmentExpiresAt = DateTimeOffset.UtcNow.AddMinutes(-1), ApprovalPath = "/app/records/connect/approve?enrollmentId=expired" };
        using var runtime = new AgentRuntime(Host(), Store(), new PackProofClient(Host(), new Handler(_ => throw new Exception("No network expected"))), state);
        var status = Json.Element(await runtime.Command("status", null, default)); Assert.False(status.TryGetProperty("approvalPath", out _));
    }
}
