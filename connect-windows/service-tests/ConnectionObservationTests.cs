using System.Net;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using PackProof.Connect;
using Xunit;

public sealed class ConnectionObservationTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "connect-observation-" + Guid.NewGuid().ToString("N"));
    private static HostConfiguration Host() => new("development", "https://api.example", "https://app.example", "S-1-5-21-1-2-3-1001");
    private sealed class PlainProtector : ISecretProtector { public byte[] Protect(byte[] bytes) => bytes.ToArray(); public byte[] Unprotect(byte[] bytes) => bytes.ToArray(); }
    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> reply) : HttpMessageHandler
    { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => Task.FromResult(reply(request)); }
    private ProtectedStore Store() { var storage = new ProtectedStore(root, new PlainProtector()); storage.Initialize(); return storage; }
    private static JsonElement Capabilities(string rules, params string[] contracts) => Json.Element(new { rulesVersion = rules, sourceContracts = contracts });
    private static HttpResponseMessage Reply(HttpStatusCode status, object body)
    { var response = new HttpResponseMessage(status) { Content = new StringContent(Json.Element(body).GetRawText()) }; response.Headers.Date = DateTimeOffset.UtcNow; response.Headers.Add("X-Request-Id", "req-synthetic-001"); return response; }
    [Fact] public void A_matching_rules_string_without_the_v2_contract_is_not_compatible()
    {
        Assert.Equal("unsupported", AgentRuntime.CapabilityState(null));
        Assert.Equal("unsupported", AgentRuntime.CapabilityState(Capabilities(CsvSemantics.Version, "packproof.scheduled-csv/v1")));
        Assert.Equal("outdated", AgentRuntime.CapabilityState(Capabilities("old", "packproof.scheduled-csv/v2")));
        Assert.Equal("compatible", AgentRuntime.CapabilityState(Capabilities(CsvSemantics.Version, "packproof.scheduled-csv/v2")));
    }
    [Fact] public async Task A_read_only_authenticated_probe_records_freshness_without_changing_authority_or_historical_error()
    {
        var requests = 0;
        var state = new LocalState { Token = "synthetic-secret", InstallationId = "installation-synthetic", LocalPaused = true, LastErrorCode = "NETWORK_UNAVAILABLE", ServerConfig = Json.Element(new { state = "ready", sourceName = "Source", integrationAccountId = "source", operatorMembershipId = "member" }) };
        using var runtime = new AgentRuntime(Host(), Store(), new PackProofClient(Host(), new Handler(request =>
        {
            requests++; Assert.Equal(HttpMethod.Get, request.Method); Assert.Equal("/v1/partner/agent/config", request.RequestUri!.AbsolutePath);
            Assert.Equal("Bearer", request.Headers.Authorization?.Scheme); Assert.Null(request.Content); Assert.False(request.Headers.Contains("Idempotency-Key"));
            return Reply(HttpStatusCode.OK, new { capabilities = Capabilities(CsvSemantics.Version, "packproof.scheduled-csv/v1", "packproof.scheduled-csv/v2"), state = "active" });
        })), state);
        var before = state.ServerConfig!.Value.GetRawText();
        await runtime.Command("preflight", null, default);
        Assert.Equal(1, requests); Assert.True(state.LocalPaused); Assert.Equal(before, state.ServerConfig.Value.GetRawText()); Assert.Equal("NETWORK_UNAVAILABLE", state.LastErrorCode);
        var observed = Assert.IsType<TransportObservation>(state.Transport); Assert.Equal("compatible", observed.State); Assert.Equal(200, observed.HttpStatus); Assert.Equal("req-synthetic-001", observed.CorrelationId);
        Assert.NotNull(observed.SucceededAt); Assert.True(observed.ExpiresAt > observed.SucceededAt); Assert.Equal(TimeSpan.FromMinutes(2), observed.ExpiresAt - observed.AttemptedAt);
        var serialized = Json.Element(await runtime.Command("diagnostics", null, default)).GetRawText(); Assert.DoesNotContain("synthetic-secret", serialized); Assert.Contains("req-synthetic-001", serialized);
    }
    [Theory][InlineData(401, "unauthenticated", "authentication")][InlineData(403, "forbidden", "authorization")][InlineData(404, "unsupported", "http")][InlineData(503, "unreachable", "server")]
    public async Task Probe_classifies_HTTP_failures_and_does_not_retry(int status, string category, string failure)
    {
        var attempts = 0; var state = new LocalState { Token = "synthetic-secret", LocalPaused = true };
        using var runtime = new AgentRuntime(Host(), Store(), new PackProofClient(Host(), new Handler(_ => { attempts++; return Reply((HttpStatusCode)status, new { code = "SYNTHETIC_FAILURE" }); })), state);
        await runtime.Command("preflight", null, default);
        Assert.Equal(1, attempts); Assert.Equal(category, state.Transport?.State); Assert.Equal(failure, state.Transport?.FailureKind); Assert.Equal(status, state.Transport?.HttpStatus); Assert.Null(state.Transport?.SourceContracts); Assert.True(state.LocalPaused);
    }
    [Fact] public async Task A_fresh_network_failure_replaces_a_previous_compatible_observation()
    {
        var state = new LocalState { Token = "synthetic-secret", Transport = new("compatible", DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddMinutes(2), 200, null, null, CsvSemantics.Version, CsvSemantics.Version, ["packproof.scheduled-csv/v2"]) };
        using var runtime = new AgentRuntime(Host(), Store(), new PackProofClient(Host(), new Handler(_ => throw new HttpRequestException(HttpRequestError.NameResolutionError))), state);
        await runtime.Command("preflight", null, default);
        Assert.Equal("unreachable", state.Transport?.State); Assert.Equal("dns", state.Transport?.FailureKind); Assert.NotNull(state.Transport?.SucceededAt); Assert.Null(state.Transport?.SourceContracts); Assert.Null(state.Transport?.HttpStatus);
    }
    [Fact] public async Task A_read_only_response_reporting_revocation_pauses_without_granting_or_overwriting_config()
    {
        var state = new LocalState { Token = "synthetic-secret", LocalPaused = false };
        using var runtime = new AgentRuntime(Host(), Store(), new PackProofClient(Host(), new Handler(_ => Reply(HttpStatusCode.OK, new { state = "revoked", capabilities = Capabilities(CsvSemantics.Version, "packproof.scheduled-csv/v2") }))), state);
        await runtime.Command("preflight", null, default);
        Assert.True(state.LocalPaused); Assert.Equal("forbidden", state.Transport?.State); Assert.Equal("authorization", state.Transport?.FailureKind); Assert.Null(state.ServerConfig);
    }
    [Theory][InlineData("null")][InlineData("[]")][InlineData("\"unsupported\"")][InlineData("{}")]
    public async Task Malformed_capabilities_are_classified_unsupported_without_retaining_prior_compatibility(string json)
    {
        var state = new LocalState { Token = "synthetic-secret" };
        using var runtime = new AgentRuntime(Host(), Store(), new PackProofClient(Host(), new Handler(_ => Reply(HttpStatusCode.OK, new { capabilities = JsonDocument.Parse(json).RootElement.Clone() }))), state);
        await runtime.Command("preflight", null, default); Assert.Equal("unsupported", state.Transport?.State); Assert.Null(state.Transport?.ObservedRulesVersion);
    }
    [Fact] public async Task A_non_object_config_response_does_not_preserve_a_compatible_observation()
    {
        var state = new LocalState { Token = "synthetic-secret" };
        using var runtime = new AgentRuntime(Host(), Store(), new PackProofClient(Host(), new Handler(_ => Reply(HttpStatusCode.OK, "invalid config"))), state);
        await runtime.Command("preflight", null, default); Assert.Equal("unreachable", state.Transport?.State); Assert.Equal("invalid_response", state.Transport?.FailureKind);
    }
    [Fact] public async Task A_successful_public_health_request_cannot_claim_authenticated_compatibility()
    {
        var state = new LocalState(); using var runtime = new AgentRuntime(Host(), Store(), new PackProofClient(Host(), new Handler(request => { Assert.Null(request.Headers.Authorization); Assert.Equal("/health", request.RequestUri!.AbsolutePath); return Reply(HttpStatusCode.OK, new { }); })), state);
        await runtime.Command("preflight", null, default); Assert.Equal("unauthenticated", state.Transport?.State); Assert.Null(state.Transport?.SourceContracts);
    }
    [Fact] public async Task Displayed_completion_time_is_reported_by_the_server_not_invented_from_local_observation()
    {
        var completed = "2026-11-16T12:00:00Z";
        var state = new LocalState { LastCompletedImportAt = DateTimeOffset.Parse("2026-11-16T12:03:00Z"), ServerConfig = Json.Element(new { state = "ready", sourceName = "Source", integrationAccountId = "source", operatorMembershipId = "member", health = new { lastCompletedImportAt = completed } }) };
        using var runtime = new AgentRuntime(Host(), Store(), new PackProofClient(Host(), new Handler(_ => throw new InvalidOperationException("No network expected"))), state);
        var status = Json.Element(await runtime.Command("status", null, default));
        Assert.Equal(completed, status.GetProperty("health").GetProperty("lastCompletedImportAt").GetString());
        state.ServerConfig = Json.Element(new { state = "ready", sourceName = "Source", integrationAccountId = "source", operatorMembershipId = "member" });
        status = Json.Element(await runtime.Command("status", null, default));
        Assert.False(status.GetProperty("health").TryGetProperty("lastCompletedImportAt", out var missing) && missing.ValueKind != JsonValueKind.Null);
    }
    public void Dispose() { using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(root, "queue.sqlite"), Mode = SqliteOpenMode.ReadWriteCreate }.ToString()); SqliteConnection.ClearPool(connection); if (Directory.Exists(root)) Directory.Delete(root, true); }
}
