using System.Net.Http;
using System.Text.Json;
namespace PackProof.Connect;

public sealed partial class AgentRuntime
{
    internal static string CapabilityState(JsonElement? capabilities)
    {
        if (capabilities?.ValueKind != JsonValueKind.Object ||
            !capabilities.Value.TryGetProperty("sourceContracts", out var contracts) || contracts.ValueKind != JsonValueKind.Array ||
            !contracts.EnumerateArray().Any(value => value.ValueKind == JsonValueKind.String && value.GetString() == "packproof.scheduled-csv/v2")) return "unsupported";
        return capabilities.Value.TryGetProperty("rulesVersion", out var version) && version.ValueKind == JsonValueKind.String && version.GetString() == CsvSemantics.Version ? "compatible" : "outdated";
    }
    private void ObserveConnection(JsonElement result, DateTimeOffset attemptedAt)
    {
        if (result.ValueKind != JsonValueKind.Object) throw new ConnectException("API_RESPONSE_INVALID", "PackProof returned an invalid connection response. No source approval was requested.");
        var capabilities = Optional(result, "capabilities");
        if (capabilities?.ValueKind != JsonValueKind.Object) capabilities = null;
        var observed = Optional(capabilities, "rulesVersion");
        var rules = observed?.ValueKind == JsonValueKind.String ? observed.Value.GetString() : null;
        // Preserve a bounded list only; unsupported malformed replies do not reach the renderer.
        var contracts = Optional(capabilities, "sourceContracts");
        var names = contracts?.ValueKind == JsonValueKind.Array ? contracts.Value.EnumerateArray().Where(value => value.ValueKind == JsonValueKind.String && value.GetString()!.Length <= 100).Take(10).Select(value => value.GetString()!).ToArray() : null;
        var now = DateTimeOffset.UtcNow;
        var revoked = Optional(result, "state") is { ValueKind: JsonValueKind.String } remoteState && remoteState.GetString() == "revoked";
        state.Transport = new(revoked ? "forbidden" : CapabilityState(capabilities), attemptedAt, now, attemptedAt.AddMinutes(2), api.LastHttpStatus, revoked ? "authorization" : null, api.LastCorrelationId, CsvSemantics.Version, rules is { Length: <= 100 } ? rules : null, names);
        if (revoked) state.LocalPaused = true;
        state.CredentialRecoveryConfirmedAt = null;
        networkOnline = true;
    }
    private void ObserveConnectionFailure(Exception error, DateTimeOffset attemptedAt)
    {
        var kind = error switch
        {
            ApiException apiError when apiError.Status == 401 => "authentication",
            ApiException apiError when apiError.Status == 403 => "authorization",
            ApiException apiError when apiError.Status == 429 => "rate_limit",
            ApiException apiError when apiError.Status >= 500 => "server",
            ApiException => "http",
            TaskCanceledException => "timeout",
            HttpRequestException transport => transport.HttpRequestError switch
            {
                HttpRequestError.NameResolutionError => "dns",
                HttpRequestError.SecureConnectionError => "tls",
                HttpRequestError.ProxyTunnelError => "proxy",
                _ => "connection"
            },
            _ => "invalid_response"
        };
        var category = error is ApiException authority ? authority.Status switch { 401 => "unauthenticated", 403 => "forbidden", 404 => "unsupported", _ => "unreachable" } : "unreachable";
        state.Transport = new(category, attemptedAt, state.Transport?.SucceededAt, attemptedAt.AddMinutes(2), api.LastHttpStatus, kind, api.LastCorrelationId, CsvSemantics.Version, null, null);
        networkOnline = false;
    }
    // Authenticated GET observes capability only. It neither proposes approval nor
    // changes server authority, local source binding or queued bytes. Explicit
    // credential denial may pause new work; success never resumes collection.
    private async Task ProbeConnection(CancellationToken ct)
    {
        var attemptedAt = DateTimeOffset.UtcNow;
        try
        {
            if (state.Token is null)
            {
                await api.Request("GET", "/health", null, null, null, ct);
                var now = DateTimeOffset.UtcNow;
                state.Transport = new("unauthenticated", attemptedAt, now, attemptedAt.AddMinutes(2), api.LastHttpStatus, "authentication", api.LastCorrelationId, CsvSemantics.Version, null, null);
            }
            else
            {
                var result = await api.Request("GET", "/v1/partner/agent/config", null, state.Token, null, ct);
                ObserveConnection(result, attemptedAt);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception error) when (error is ApiException or HttpRequestException or TaskCanceledException or JsonException or ConnectException)
        {
            ObserveConnectionFailure(error, attemptedAt);
            if (error is ApiException denied && denied.Status is 401 or 403)
            {
                state.LocalPaused = true;
                state.CredentialRecoveryConfirmedAt = DateTimeOffset.UtcNow;
            }
        }
        Save();
    }
    private object Versions() => new { service = InstalledVersion, bridgeProtocol = 1, csvRules = CsvSemantics.Version, csvProfile = CsvSemantics.Profile, environment = host.Environment, apiOrigin = new Uri(host.ApiOrigin).GetLeftPart(UriPartial.Authority) };
}
