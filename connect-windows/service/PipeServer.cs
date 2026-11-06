using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
namespace PackProof.Connect;

public sealed class PipeServer(HostConfiguration host, AgentRuntime agent)
{
    public const int MaxRequestBytes = 65536, MaxResponseBytes = 262144;
    public static PipeSecurity Security(string operatorsSid, string serviceName)
    {
        var acl = new PipeSecurity(); acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        acl.AddAccessRule(new PipeAccessRule((SecurityIdentifier)new NTAccount($"NT SERVICE\\{serviceName}").Translate(typeof(SecurityIdentifier)), PipeAccessRights.FullControl, AccessControlType.Allow));
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(operatorsSid), PipeAccessRights.ReadWrite, AccessControlType.Allow)); return acl;
    }
    public async Task Run(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            using var pipe = NamedPipeServerStreamAcl.Create(host.PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, MaxRequestBytes, MaxResponseBytes, Security(host.OperatorsSid, host.ServiceName));
            await pipe.WaitForConnectionAsync(ct);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(45));
            try
            {
                string? caller = null; pipe.RunAsClient(() => caller = WindowsIdentity.GetCurrent().User?.Value);
                if (caller is null) throw new ConnectException("LOCAL_CALLER_DENIED", "This Windows identity cannot use the collection service.");
                var data = new List<byte>(); var one = new byte[1]; while (true) { var n = await pipe.ReadAsync(one, timeout.Token); if (n == 0) throw new ConnectException("LOCAL_REQUEST_INCOMPLETE", "The local request was incomplete."); if (one[0] == 10) break; if (data.Count >= MaxRequestBytes) throw new ConnectException("LOCAL_REQUEST_LIMIT", "The local request exceeds its size limit."); data.Add(one[0]); }
                PipeRequest? request = null; object response;
                try
                {
                    request = Json.Read<PipeRequest>(data.ToArray());
                    if (request.Version != 1 || request.Id.Length is < 1 or > 80 || request.Operation.Length > 40) throw new ConnectException("LOCAL_PROTOCOL_UNSUPPORTED", "This setup app and service are incompatible. Repair the matching installation.");
                    if (request.Payload?.ValueKind is not (null or JsonValueKind.Object)) throw new ConnectException("LOCAL_REQUEST_INVALID", "The local request is invalid.");
                    var result = await agent.Command(request.Operation, request.Payload, timeout.Token); response = new { version = 1, id = request.Id, ok = true, result };
                }
                catch (ConnectException e) { response = new { version = 1, id = request?.Id, ok = false, error = new { code = e.Code, message = e.Message } }; }
                catch (ApiException e) { response = new { version = 1, id = request?.Id, ok = false, error = new { code = e.Code, message = "PackProof needs an approved action before this step can finish. Your queued work is preserved." } }; }
                catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException or ArgumentException) { response = new { version = 1, id = request?.Id, ok = false, error = new { code = "LOCAL_REQUEST_INVALID", message = "The local request is invalid. Refresh the setup app." } }; }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { response = new { version = 1, id = request?.Id, ok = false, error = new { code = "LOCAL_STORAGE_UNAVAILABLE", message = "The service cannot safely access its approved local storage. Queued work is preserved; ask IT to check disk space and permissions." } }; }
                catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { response = new { version = 1, id = request?.Id, ok = false, error = new { code = "NETWORK_UNAVAILABLE", message = "PackProof could not be reached. Your queued work is preserved; check the service network connection." } }; }
                var output = Json.Bytes(response); if (output.Length > MaxResponseBytes) output = Json.Bytes(new { version = 1, id = request?.Id, ok = false, error = new { code = "LOCAL_RESPONSE_LIMIT", message = "The local preview is too large. Use a smaller setup export." } });
                await pipe.WriteAsync(output, timeout.Token); await pipe.WriteAsync(new byte[] { 10 }, timeout.Token); await pipe.FlushAsync(timeout.Token);
            }
            catch (Exception e) when (e is IOException or OperationCanceledException or ConnectException) { if (ct.IsCancellationRequested) break; }
        }
    }
}
