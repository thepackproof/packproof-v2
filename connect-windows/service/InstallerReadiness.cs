using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
namespace PackProof.Connect;

// Separate local administrator-only, read-only installation attestation.
// It cannot enroll a PC, change a source, upload a file, or control collection.
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class InstallerReadiness(HostConfiguration host, AgentRuntime agent)
{
    public static PipeSecurity Security(string serviceName)
    {
        var acl = new PipeSecurity(); acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        acl.AddAccessRule(new PipeAccessRule((SecurityIdentifier)new NTAccount($"NT SERVICE\\{serviceName}").Translate(typeof(SecurityIdentifier)), PipeAccessRights.FullControl, AccessControlType.Allow));
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
        return acl;
    }
    private async Task<object> Check(string nonce, CancellationToken ct)
    {
        var phase = "service_status";
        try
        {
            var status = Json.Element(await agent.Command("status", null, ct));
            if (status.TryGetProperty("error", out var error))
                throw new ConnectException(error.GetProperty("code").GetString()!, error.GetProperty("message").GetString()!);
            if (!status.GetProperty("health").GetProperty("serviceOnline").GetBoolean())
                throw new ConnectException("SERVICE_NOT_READY", "The installed collector has not completed startup.");
            phase = "service_identity";
            if (!WindowsIdentity.GetCurrent().User!.IsWellKnown(WellKnownSidType.LocalServiceSid))
                throw new ConnectException("SERVICE_IDENTITY_INVALID", "The readiness check must run in the installed LocalService process.");
            phase = "protected_storage";
            var store = new ProtectedStore(host.DataRoot, new ServiceIdentityProtector());
            store.Initialize();
            // Read existing material without generating a key or replacing state.
            _ = store.Read<JsonElement>("state.bin");
            if (store.Read<byte[]>("spool-key.bin") is not { Length: 32 })
                throw new ConnectException("SPOOL_KEY_MISSING", "The existing queue has no usable protected key. Preserve it; setup will not create a replacement.");
            phase = "spool_write_replace";
            ProtectedStore.ProbeDirectory(Path.Combine(host.DataRoot, "spool"));
            phase = "queue_read_write_lock";
            using (var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(host.DataRoot, "queue.sqlite"), Mode = SqliteOpenMode.ReadWrite, DefaultTimeout = 2 }.ToString()))
            {
                db.Open();
                using var command = db.CreateCommand();
                command.CommandText = "PRAGMA quick_check(1)";
                if (!string.Equals(command.ExecuteScalar() as string, "ok", StringComparison.Ordinal))
                    throw new ConnectException("LOCAL_QUEUE_INTEGRITY_FAILED", "The retained queue did not pass its integrity check. Preserve its database, journal and keys; setup will not reset them.");
                // Verify SQLite can acquire the writer lock without changing rows.
                command.CommandText = "BEGIN IMMEDIATE"; command.ExecuteNonQuery();
                command.CommandText = "ROLLBACK"; command.ExecuteNonQuery();
            }
            phase = "disk_reserve";
            if (new DriveInfo(Path.GetPathRoot(host.DataRoot)!).AvailableFreeSpace < DurableQueue.DiskReserveBytes)
                throw new ConnectException("LOCAL_STORAGE_FULL", "At least 1 GiB of free reserve is required. Free disk space and rerun the installer; queued data was preserved.");
            return new { schema = "packproof.connect-readiness/v1", nonce, processId = Environment.ProcessId, ready = true, checks = new[] { "service_identity", "dpapi", "protected_storage_write_read_replace_delete", "existing_key", "spool_write_read_replace_delete", "queue_integrity", "queue_write_lock", "disk_reserve" }, cloudConnection = "not_checked", dataReset = false };
        }
        catch (ConnectException error) { return Failed(nonce, phase, error.Code, error.Message); }
        catch (SqliteException error) { return Failed(nonce, phase, error.SqliteErrorCode is 5 or 6 ? "LOCAL_QUEUE_BUSY" : "LOCAL_QUEUE_UNAVAILABLE", "The retained queue could not pass its readiness check. Its database, journal and keys were not reset."); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        { var failure = LocalIo.Failure(error, phase); return Failed(nonce, phase, failure.Code, failure.Message); }
        catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException)
        { return Failed(nonce, phase, "LOCAL_STATE_INVALID", "The installed service returned incompatible or invalid state. Repair the matching installation without deleting retained data."); }
    }
    private static object Failed(string nonce, string phase, string code, string message) => new { schema = "packproof.connect-readiness/v1", nonce, processId = Environment.ProcessId, ready = false, phase, code, message, dataReset = false };
    public async Task Run(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            using var pipe = NamedPipeServerStreamAcl.Create(host.PipeName + "-readiness", PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 128, 8192, Security(host.ServiceName));
            await pipe.WaitForConnectionAsync(ct);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct); deadline.CancelAfter(TimeSpan.FromSeconds(10));
            try
            {
                var input = new List<byte>(); var one = new byte[1];
                while (true)
                {
                    if (await pipe.ReadAsync(one, deadline.Token) == 0) throw new IOException("Incomplete readiness request.");
                    if (one[0] == 10) break;
                    if (input.Count >= 32 || !((one[0] >= '0' && one[0] <= '9') || (one[0] >= 'a' && one[0] <= 'f'))) throw new IOException("Invalid readiness request.");
                    input.Add(one[0]);
                }
                if (input.Count != 32) throw new IOException("Invalid readiness challenge.");
                var response = Json.Bytes(await Check(Encoding.ASCII.GetString(input.ToArray()), deadline.Token));
                if (response.Length > 8192) throw new IOException("Readiness reply limit.");
                await pipe.WriteAsync(response, deadline.Token); await pipe.WriteAsync(new byte[] { 10 }, deadline.Token); await pipe.FlushAsync(deadline.Token);
            }
            catch (Exception error) when (error is IOException or OperationCanceledException or UnauthorizedAccessException) { if (ct.IsCancellationRequested) break; }
        }
    }
}
