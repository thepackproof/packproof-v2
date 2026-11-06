using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    private static readonly HashSet<string> Operations = ["status", "preflight", "beginEnrollment", "pollEnrollment", "selectFolder", "localPreview", "proposeConfiguration", "preview", "commit", "verify", "proposeActivation", "activate", "pause", "resume", "refresh", "diagnostics", "checkpoint"];
    public static async Task<int> Main()
    {
        string id = "unknown";
        try
        {
            if (!OperatingSystem.IsWindows()) throw new InvalidOperationException();
            var input = await ReadBounded(Console.OpenStandardInput(), 64 * 1024);
            using var request = JsonDocument.Parse(input);
            var root = request.RootElement;
            id = root.GetProperty("id").GetString() ?? throw new InvalidOperationException();
            if (!Guid.TryParse(id, out _) || root.GetProperty("version").GetInt32() != 1 || !Operations.Contains(root.GetProperty("operation").GetString() ?? "") || root.EnumerateObject().Any(x => !new[] { "id", "version", "operation", "payload" }.Contains(x.Name))) throw new InvalidOperationException();
            var config = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "bridge-config.json"))).RootElement;
            var channel = config.GetProperty("channel").GetString();
            if (channel is not ("development" or "staging" or "production")) throw new InvalidOperationException();
            var serviceName = "PackProofConnect" + char.ToUpperInvariant(channel[0]) + channel[1..];
            var pipeName = "PackProofConnect-" + channel + "-v1";
            var expected = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "service", "PackProof.Connect.Service.exe"));
            using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous, System.Security.Principal.TokenImpersonationLevel.Identification);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            await pipe.ConnectAsync(timeout.Token);
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var pid) || pid == 0 || pid != ServiceProcessId(serviceName)) throw new InvalidOperationException();
            using var process = OpenProcess(0x1000, false, pid);
            var path = new StringBuilder(32768); uint length = 32768;
            if (process.IsInvalid || !QueryFullProcessImageName(process, 0, path, ref length) || !string.Equals(Path.GetFullPath(path.ToString()), expected, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
            if (channel != "development") VerifyPublisher(expected, config.GetProperty("publisher").GetString() ?? "");
            await pipe.WriteAsync(Encoding.UTF8.GetBytes(input + "\n"), timeout.Token);
            await pipe.FlushAsync(timeout.Token);
            var response = await ReadBounded(pipe, 256 * 1024, timeout.Token);
            using var parsed = JsonDocument.Parse(response);
            if (parsed.RootElement.GetProperty("id").GetString() != id || parsed.RootElement.GetProperty("version").GetInt32() != 1) throw new InvalidOperationException();
            await Console.Out.WriteLineAsync(response);
            return 0;
        }
        catch
        {
            await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new { version = 1, id, ok = false, error = new { code = "SERVICE_BRIDGE_UNAVAILABLE", message = "The trusted background service could not be verified or reached. Repair this installation; queued work is preserved." } }));
            return 1;
        }
    }
    private static async Task<string> ReadBounded(Stream stream, int limit, CancellationToken token = default)
    {
        using var result = new MemoryStream(); var one = new byte[1];
        while (await stream.ReadAsync(one, token) != 0)
        {
            if (one[0] == 10) break;
            if (result.Length >= limit) throw new InvalidOperationException();
            result.WriteByte(one[0]);
        }
        return new UTF8Encoding(false, true).GetString(result.ToArray());
    }
    private static uint ServiceProcessId(string name)
    {
        var manager = OpenSCManager(null, null, 1); if (manager == IntPtr.Zero) throw new InvalidOperationException();
        try
        {
            var service = OpenService(manager, name, 4); if (service == IntPtr.Zero) throw new InvalidOperationException();
            try
            {
                var size = Marshal.SizeOf<ServiceStatus>(); var buffer = Marshal.AllocHGlobal(size);
                try { if (!QueryServiceStatusEx(service, 0, buffer, (uint)size, out _)) throw new InvalidOperationException(); var status = Marshal.PtrToStructure<ServiceStatus>(buffer); if (status.State != 4) throw new InvalidOperationException(); return status.Pid; }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }
    private static void VerifyPublisher(string path, string publisher)
    {
        if (string.IsNullOrWhiteSpace(publisher)) throw new InvalidOperationException();
        var info = new TrustFile { Size = (uint)Marshal.SizeOf<TrustFile>(), FilePath = path };
        var pointer = Marshal.AllocHGlobal(Marshal.SizeOf<TrustFile>());
        try
        {
            Marshal.StructureToPtr(info, pointer, false);
            var data = new TrustData { Size = (uint)Marshal.SizeOf<TrustData>(), UiChoice = 2, RevocationChecks = 1, UnionChoice = 1, File = pointer, StateAction = 0, ProviderFlags = 0x80 };
            var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
            if (WinVerifyTrust(new IntPtr(-1), ref action, ref data) != 0) throw new InvalidOperationException();
#pragma warning disable SYSLIB0057
            using var cert = new X509Certificate2(X509Certificate.CreateFromSignedFile(path));
#pragma warning restore SYSLIB0057
            if (!string.Equals(cert.GetNameInfo(X509NameType.SimpleName, false), publisher, StringComparison.Ordinal)) throw new InvalidOperationException();
        }
        finally { Marshal.DestroyStructure<TrustFile>(pointer); Marshal.FreeHGlobal(pointer); }
    }
    [StructLayout(LayoutKind.Sequential)] private struct ServiceStatus { public uint Type, State, Controls, Win32Exit, ServiceExit, Checkpoint, WaitHint, Pid, Flags; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct TrustFile { public uint Size; [MarshalAs(UnmanagedType.LPWStr)] public string FilePath; public IntPtr File, KnownSubject; }
    [StructLayout(LayoutKind.Sequential)] private struct TrustData { public uint Size; public IntPtr PolicyCallback, SipClient; public uint UiChoice, RevocationChecks, UnionChoice; public IntPtr File; public uint StateAction; public IntPtr StateData, UrlReference; public uint ProviderFlags, UiContext; public IntPtr SignatureSettings; }
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder name, ref uint size);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenSCManager(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenService(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatusEx(IntPtr service, uint level, IntPtr buffer, uint size, out uint needed);
    [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr service);
    [DllImport("wintrust.dll", ExactSpelling = true)] private static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);
}
