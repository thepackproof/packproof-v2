// Development-CI probe only. This file is not shipped in the Connect package.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security;
using System.Text;
using System.Text.Json;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public sealed class ConnectIdentityProbeResult
{
    public string IdentitySid { get; set; }
    public bool IsAdministrator { get; set; }
    public bool IsNetworkLogon { get; set; }
    public bool IsInteractiveLogon { get; set; }
    public string PipeAccess { get; set; }
    public string ProtectedFileAccess { get; set; }
}

public static class ConnectNativeSecurityProbe
{
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool LogonUser(string name, string domain, string password, int logonType, int provider, out SafeAccessTokenHandle token);

    public static ConnectIdentityProbeResult CheckIdentity(string name, string password, int logonType, string expectedSid, string pipeName, string protectedFile)
    {
        if (logonType != 2 && logonType != 3) throw new ArgumentException("Only the declared local interactive and network-token fixtures are supported.");
        SafeAccessTokenHandle token;
        if (!LogonUser(name, ".", password, logonType, 0, out token)) throw new Win32Exception(Marshal.GetLastWin32Error(), "The isolated test identity could not log on.");
        using (token)
        {
            return WindowsIdentity.RunImpersonated(token, () =>
            {
                using (var identity = WindowsIdentity.GetCurrent())
                {
                    var groups = identity.Groups == null ? new string[0] : identity.Groups.Select(group => group.Value).ToArray();
                    var administrator = new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
                    if (identity.User == null || identity.User.Value != expectedSid || administrator || (logonType == 2 ? !groups.Contains("S-1-5-4") || groups.Contains("S-1-5-2") : !groups.Contains("S-1-5-2")))
                        throw new InvalidOperationException("The disposable identity did not have the expected standard-user logon context.");
                    return new ConnectIdentityProbeResult
                    {
                        IdentitySid = identity.User.Value,
                        IsAdministrator = administrator,
                        IsNetworkLogon = groups.Contains("S-1-5-2"),
                        IsInteractiveLogon = groups.Contains("S-1-5-4"),
                        PipeAccess = ReadBoundedStatus(pipeName),
                        ProtectedFileAccess = ReadProtectedFile(protectedFile)
                    };
                }
            });
        }
    }

    private static string ReadProtectedFile(string path)
    {
        try
        {
            using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) file.ReadByte();
            return "allowed";
        }
        catch (UnauthorizedAccessException) { return "denied"; }
        // Missing files, sharing failures and other IO errors are not proof of denied access.
    }

    private static string ReadBoundedStatus(string pipeName)
    {
        using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification))
        {
            try { pipe.Connect(5000); }
            catch (UnauthorizedAccessException) { return "denied"; }
            // A timeout or unavailable pipe must fail the test, not count as an ACL denial.
            var id = Guid.NewGuid().ToString();
            var request = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { version = 1, id, operation = "status" }) + "\n");
            using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5)))
            {
                pipe.WriteAsync(request.AsMemory(), deadline.Token).AsTask().GetAwaiter().GetResult();
                pipe.FlushAsync(deadline.Token).GetAwaiter().GetResult();
                using (var output = new MemoryStream())
                {
                    var one = new byte[1];
                    while (pipe.ReadAsync(one.AsMemory(), deadline.Token).AsTask().GetAwaiter().GetResult() != 0)
                    {
                        if (one[0] == 10) break;
                        if (output.Length >= 262144) throw new InvalidOperationException("The identity probe received an oversized response.");
                        output.WriteByte(one[0]);
                    }
                    using (var response = JsonDocument.Parse(output.ToArray()))
                    {
                        var root = response.RootElement;
                        if (root.GetProperty("id").GetString() != id || root.GetProperty("version").GetInt32() != 1 || !root.GetProperty("ok").GetBoolean() || !root.GetProperty("result").GetProperty("health").GetProperty("serviceOnline").GetBoolean())
                            throw new InvalidOperationException("The identity probe did not retrieve a real service status.");
                    }
                }
            }
            return "allowed_status";
        }
    }

    public static void AssertVerifiedBridgeAsStandardUser(string name, string password, string bridgePath)
    {
        // Launch the exact packaged bridge under a real non-administrator token.
        // The direct pipe test is not sufficient: ordinary operators also need
        // the Win32/SCM identity checks used by the Electron subprocess.
        using (var secret = new SecureString())
        {
            foreach (char character in password) secret.AppendChar(character);
            secret.MakeReadOnly();
            var start = new ProcessStartInfo(bridgePath)
            {
                UserName = name,
                Domain = ".",
                Password = secret,
                LoadUserProfile = false,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardInputEncoding = new UTF8Encoding(false)
            };
            using (var child = Process.Start(start))
            {
                if (child == null) throw new InvalidOperationException("The standard-user bridge could not launch.");
                try
                {
                    var id = Guid.NewGuid().ToString();
                    child.StandardInput.WriteLine(JsonSerializer.Serialize(new { version = 1, id, operation = "status" }));
                    child.StandardInput.Close();
                    if (!child.WaitForExit(20000)) throw new TimeoutException("The standard-user verified bridge did not respond.");
                    var output = child.StandardOutput.ReadToEnd();
                    using (var parsed = JsonDocument.Parse(output))
                    {
                        var root = parsed.RootElement;
                        if (child.ExitCode != 0 || root.GetProperty("version").GetInt32() != 1 ||
                            root.GetProperty("id").GetString() != id ||
                            !root.GetProperty("ok").GetBoolean() ||
                            !root.GetProperty("result").GetProperty("health").GetProperty("serviceOnline").GetBoolean())
                        {
                            string code = root.TryGetProperty("error", out var error) &&
                                error.TryGetProperty("code", out var errorCode) ? errorCode.GetString() : "NO_CODE";
                            throw new InvalidOperationException("The standard-user verified bridge rejected the registered helper: " + code);
                        }
                    }
                }
                finally
                {
                    if (!child.HasExited) { child.Kill(true); child.WaitForExit(5000); }
                }
            }
        }
    }

    public static void AssertCounterfeitPeerRejected(string pipeName, string bridgePath)
    {
        // The caller has stopped the registered service and checked its old PID exited.
        // Accept the actual helper connection, then prove it sends no request bytes.
        using (var fake = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
        using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10)))
        {
            var connection = fake.WaitForConnectionAsync(deadline.Token);
            var id = Guid.NewGuid().ToString();
            var start = new ProcessStartInfo(bridgePath)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardInputEncoding = new UTF8Encoding(false)
            };
            using (var child = Process.Start(start))
            {
                if (child == null) throw new InvalidOperationException("The installed bridge could not launch.");
                try
                {
                    var errorOutput = child.StandardError.ReadToEndAsync();
                    child.StandardInput.WriteLine(JsonSerializer.Serialize(new { version = 1, id, operation = "status", payload = new { syntheticCanary = "must-never-reach-counterfeit-peer" } }));
                    child.StandardInput.Close();
                    connection.GetAwaiter().GetResult();
                    var one = new byte[1];
                    var received = fake.ReadAsync(one.AsMemory(), deadline.Token).AsTask().GetAwaiter().GetResult();
                    if (received != 0) throw new InvalidOperationException("The helper transmitted request bytes to a counterfeit peer.");
                    if (!child.WaitForExit(5000)) throw new TimeoutException("The helper did not finish its peer rejection.");
                    using (var response = JsonDocument.Parse(child.StandardOutput.ReadToEnd()))
                    {
                        var root = response.RootElement;
                        if (child.ExitCode != 1 || root.GetProperty("id").GetString() != id || root.GetProperty("ok").GetBoolean() || !new[] { "SERVICE_NOT_RUNNING", "SERVICE_PIPE_PEER_MISMATCH", "SERVICE_IDENTITY_MISMATCH" }.Contains(root.GetProperty("error").GetProperty("code").GetString()))
                            throw new InvalidOperationException("The helper did not return the bounded peer-verification refusal.");
                    }
                    errorOutput.GetAwaiter().GetResult();
                }
                finally { if (!child.HasExited) { child.Kill(true); child.WaitForExit(5000); } }
            }
        }
    }
}
