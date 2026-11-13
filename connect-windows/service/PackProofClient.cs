using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
namespace PackProof.Connect;

public sealed class ApiException(string code, int status, TimeSpan? retryAfter = null) : Exception(code) { public string Code { get; } = code; public int Status { get; } = status; public TimeSpan? RetryAfter { get; } = retryAfter; public bool Transient => Status is 408 or 429 or >= 500; }
public sealed class PackProofClient : IDisposable
{
    private readonly HttpClient http;
    private readonly TimeProvider time;
    private DateTimeOffset? serverDate;
    private long serverDateTimestamp;
    // HTTP Date describes the time at receipt, not the time of the next action.
    // Project it using elapsed (Stopwatch) time, independent of wall-clock edits.
    public DateTimeOffset? LastServerDate => serverDate is { } observed ? observed + time.GetElapsedTime(serverDateTimestamp) : null;
    public bool LastResponseHadServerDate { get; private set; }
    public PackProofClient(HostConfiguration host, HttpMessageHandler? handler = null, TimeProvider? timeProvider = null)
    {
        host.Validate(); time = timeProvider ?? TimeProvider.System;
        http = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false, UseProxy = true }) { BaseAddress = new Uri(host.ApiOrigin), Timeout = TimeSpan.FromSeconds(30), MaxResponseContentBufferSize = 6 * 1024 * 1024 };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("PackProofConnect/"+AgentRuntime.InstalledVersion);
    }
    public async Task<JsonElement> Request(string method, string path, object? body, string? token, string? key, CancellationToken ct)
    {
        if (!path.StartsWith('/') || path.StartsWith("//") || path.Contains('\\') || path.Contains('#') || path.Contains('?')) throw new ConnectException("API_OPERATION_INVALID", "This API operation is not permitted.");
        // ResponseHeadersRead ends HttpClient's own timeout at the headers. Keep
        // the same bounded deadline over error and success body streaming too.
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(30)); ct = deadline.Token;
        using var request = new HttpRequestMessage(new HttpMethod(method), path);
        if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (key is not null) request.Headers.Add("Idempotency-Key", key);
        if (body is not null) { var bytes = body is ExactJsonBody exact ? exact.Bytes : Json.Bytes(body); if (body is ExactJsonBody checkedBody && Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes)) != checkedBody.Sha256) throw new ConnectException("REQUEST_BODY_INTEGRITY_FAILED", "The preserved upload request failed its integrity check. Queued work is preserved."); if (bytes.Length > 6 * 1024 * 1024) throw new ConnectException("CSV_WIRE_LIMIT", "The encoded source exceeds the upload limit. Ask the source owner for a smaller approved export."); request.Content = new ByteArrayContent(bytes); request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json"); }
        LastResponseHadServerDate = false;
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        LastResponseHadServerDate = response.Headers.Date is not null;
        if (response.Headers.Date is { } observedDate) { serverDate = observedDate; serverDateTimestamp = time.GetTimestamp(); }
        // A missing Date header must not erase a previously observed clock skew.
        if (!response.IsSuccessStatusCode)
        {
            string code = "PACKPROOF_REQUEST_FAILED";
            try { await using var errorStream = await response.Content.ReadAsStreamAsync(ct); using var safeBody = new MemoryStream(); var part = new byte[4096]; int n; while ((n = await errorStream.ReadAsync(part, ct)) > 0) { if (safeBody.Length + n > 65536) break; safeBody.Write(part, 0, n); } if (n == 0) { var error = Json.Read<JsonElement>(safeBody.ToArray()); if (error.TryGetProperty("code", out var c)) code = c.GetString() ?? code; } }
            catch (Exception e) when (e is JsonException or HttpRequestException) { }
            var retry = response.Headers.RetryAfter?.Delta ?? (response.Headers.RetryAfter?.Date - DateTimeOffset.UtcNow); if (retry < TimeSpan.Zero) retry = TimeSpan.Zero;
            throw new ApiException(code, (int)response.StatusCode, retry);
        }
        if (response.Content.Headers.ContentLength > 6 * 1024 * 1024) throw new ConnectException("API_RESPONSE_LIMIT", "The server response exceeds the supported size.");
        await using var stream = await response.Content.ReadAsStreamAsync(ct); using var output = new MemoryStream(); var buffer = new byte[8192]; int read; while ((read = await stream.ReadAsync(buffer, ct)) > 0) { if (output.Length + read > 6 * 1024 * 1024) throw new ConnectException("API_RESPONSE_LIMIT", "The server response exceeds the supported size."); output.Write(buffer, 0, read); }
        return Json.Read<JsonElement>(output.ToArray());
    }
    public void Dispose() => http.Dispose();
}
