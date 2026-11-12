using System.ComponentModel;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
namespace PackProof.Connect;

// Never expose exception.Message: Windows exceptions can contain source paths.
public static class LocalIo
{
    internal static int NativeError(Exception error)
    {
        if (error is Win32Exception native) return native.NativeErrorCode;
        if (error.InnerException is not null) return NativeError(error.InnerException);
        return error.HResult & 0xffff;
    }
    internal static ConnectException Failure(Exception error, string operation)
    {
        var number = NativeError(error);
        var code = error is UnauthorizedAccessException || number == 5 ? "LOCAL_STORAGE_ACCESS_DENIED"
            : number is 32 or 33 ? "LOCAL_STORAGE_BUSY"
            : number is 39 or 112 ? "LOCAL_STORAGE_FULL"
            : error is FileNotFoundException or DirectoryNotFoundException ? "LOCAL_STORAGE_PATH_MISSING"
            : "LOCAL_STORAGE_IO_FAILED";
        var advice = code switch
        {
            "LOCAL_STORAGE_ACCESS_DENIED" => "Run the PackProof installer again to repair its dedicated storage permissions.",
            "LOCAL_STORAGE_BUSY" => "Another process is holding a protected file open. Retry after it releases the file; do not delete the file.",
            "LOCAL_STORAGE_FULL" => "Free space on the installation drive, then retry.",
            "LOCAL_STORAGE_PATH_MISSING" => "Run the PackProof installer again to check the missing protected storage path.",
            _ => "Run the PackProof installer again for its storage readiness check. Preserve existing data if repair is blocked."
        };
        return new(code, $"PackProof could not complete {operation} (Windows error {number}). {advice} Existing records and keys have not been reset.");
    }
    public static T Run<T>(string operation, Func<T> action)
    {
        for (var attempt = 0; ; attempt++)
        {
            try { return action(); }
            catch (IOException error) when (NativeError(error) is 32 or 33 && attempt < 2)
            { Thread.Sleep(attempt == 0 ? 100 : 250); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            { throw Failure(error, operation); }
        }
    }
    public static void Run(string operation, Action action) => Run(operation, () => { action(); return true; });
}

[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public static class ProtectedAncestry
{
    private static readonly HashSet<string> Administrators = ["S-1-5-18", "S-1-5-32-544"];
    private const FileSystemRights ReplacementRights = FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
    private static ConnectException Unsafe() => new("PROTECTED_STORAGE_PERMISSIONS", "The protected storage path has an unsafe owner or replacement permissions. Ask IT to repair the dedicated Connect path and its shared parents; the service has not changed shared folder permissions or opened the queue.");
    internal static void AssertAcl(DirectorySecurity acl, string serviceSid, bool leaf)
    {
        if (acl.GetOwner(typeof(SecurityIdentifier)) is not SecurityIdentifier owner || !Administrators.Contains(owner.Value)) throw Unsafe();
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow || (rule.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
            var sid = ((SecurityIdentifier)rule.IdentityReference).Value;
            if (!Administrators.Contains(sid) && !(leaf && sid == serviceSid) && (rule.FileSystemRights & ReplacementRights) != 0) throw Unsafe();
        }
    }
    public static void Assert(string root, string boundary, string serviceSid) => LocalIo.Run("inspect_storage_permissions", () =>
    {
        var path = Path.GetFullPath(root).TrimEnd('\\'); var parentBoundary = Path.GetFullPath(boundary).TrimEnd('\\');
        if (!path.StartsWith(parentBoundary + "\\", StringComparison.OrdinalIgnoreCase)) throw Unsafe();
        var leaf = true;
        for (var directory = new DirectoryInfo(path); directory is not null; directory = directory.Parent)
        {
            var attributes = File.GetAttributes(directory.FullName);
            if ((attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0) throw Unsafe();
            AssertAcl(directory.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access), serviceSid, leaf);
            if (directory.FullName.TrimEnd('\\').Equals(parentBoundary, StringComparison.OrdinalIgnoreCase)) return;
            leaf = false;
        }
        throw Unsafe();
    });
}

public interface ISecretProtector { byte[] Protect(byte[] bytes); byte[] Unprotect(byte[] bytes); }
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class ServiceIdentityProtector : ISecretProtector
{
    private static readonly byte[] Entropy = "PackProof.Connect.Service.v1"u8.ToArray();
    public byte[] Protect(byte[] bytes)
    {
        try { return ProtectedData.Protect(bytes, Entropy, DataProtectionScope.CurrentUser); }
        catch (Exception e) when (e is CryptographicException or PlatformNotSupportedException) { throw new ConnectException("PROTECTED_STORAGE_UNAVAILABLE", "Windows cannot protect data as the collection service. Ask IT to repair the service identity; queued work is preserved."); }
    }
    public byte[] Unprotect(byte[] bytes)
    {
        try { return ProtectedData.Unprotect(bytes, Entropy, DataProtectionScope.CurrentUser); }
        catch (Exception e) when (e is CryptographicException or PlatformNotSupportedException) { throw new ConnectException("PROTECTED_STORAGE_UNAVAILABLE", "The collection service cannot unlock its protected data. Preserve this computer and contact support."); }
    }
}
public sealed class ProtectedStore(string root, ISecretProtector protector)
{
    [System.Runtime.InteropServices.DllImport("kernel32.dll", EntryPoint = "MoveFileExW", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool MoveFileEx(string existing, string replacement, uint flags);
    public string Root { get; } = root;
    public void Initialize()
    {
        LocalIo.Run("open_storage_directory", () => Directory.CreateDirectory(Root));
        var sample = RandomNumberGenerator.GetBytes(32);
        if (!CryptographicOperations.FixedTimeEquals(sample, protector.Unprotect(protector.Protect(sample)))) throw new ConnectException("PROTECTED_STORAGE_UNAVAILABLE", "Protected storage did not pass its service identity check.");
        ProbeDirectory(Root);
    }
    private static string Role(string name) => name switch { "state.bin" => "protected_state", "spool-key.bin" => "encryption_key", _ => "protected_data" };
    private static void AssertOrdinaryFile(string path)
    {
        try
        {
            if ((File.GetAttributes(path) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
                throw new ConnectException("PROTECTED_STORAGE_LINK", "A protected file is not an ordinary local file. Preserve it and contact support; PackProof will not follow or replace links.");
        }
        catch (FileNotFoundException) { }
    }
    public T? Read<T>(string name)
    {
        var data = LocalIo.Run<byte[]?>("read_" + Role(name), () =>
        {
            var path = Path.Combine(Root, name); AssertOrdinaryFile(path);
            // File.Exists returns false on access errors. Only an actual missing
            // file is absence; inaccessible state/key material must never reset.
            try { return File.ReadAllBytes(path); } catch (FileNotFoundException) { return null; }
        });
        if (data is null) return default;
        try { return Json.Read<T>(protector.Unprotect(data)); }
        catch (System.Text.Json.JsonException) { throw new ConnectException("LOCAL_STATE_INVALID", "Existing protected data could not be decoded. Preserve its files and keys; the installer will not replace it with empty state."); }
    }
    public void Write<T>(string name, T value) => AtomicWrite(Path.Combine(Root, name), protector.Protect(Json.Bytes(value)));
    public byte[] Key()
    {
        var existing = Read<byte[]>("spool-key.bin");
        if (existing is not null)
        {
            if (existing.Length != 32) throw new ConnectException("SPOOL_KEY_INVALID", "The existing spool key is invalid. Preserve the queue and key; a replacement key will not be generated.");
            return existing;
        }
        var retained = LocalIo.Run("inspect_retained_queue", () =>
        {
            try { _ = File.GetAttributes(Path.Combine(Root, "queue.sqlite")); return true; } catch (FileNotFoundException) { }
            var spool = Path.Combine(Root, "spool");
            try
            {
                var attributes = File.GetAttributes(spool);
                if ((attributes & FileAttributes.ReparsePoint) != 0) throw new ConnectException("PROTECTED_STORAGE_LINK", "The protected spool must not be a link. Existing data was preserved.");
                return Directory.EnumerateFileSystemEntries(spool).Any();
            }
            catch (FileNotFoundException) { return false; }
            catch (DirectoryNotFoundException) when (Directory.Exists(Root)) { return false; }
        });
        if (retained) throw new ConnectException("SPOOL_KEY_MISSING", "The retained queue has no protected encryption key. Preserve its files and contact support; a new empty queue will not be created.");
        var key = RandomNumberGenerator.GetBytes(32); Write("spool-key.bin", key); return key;
    }
    public static void AtomicWrite(string target, byte[] data) => LocalIo.Run("replace_protected_file", () =>
    {
        var temp = target + ".new";
        AssertOrdinaryFile(target); AssertOrdinaryFile(temp);
        using (var f = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { f.Write(data); f.Flush(true); }
        if (OperatingSystem.IsWindows())
        {
            if (!MoveFileEx(temp, target, 0x1 | 0x8)) throw new IOException("The protected file could not be durably replaced.", new Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error()));
        }
        else File.Move(temp, target, true);
    });
    public static void ProbeDirectory(string directory)
    {
        // Unique disposable probe only: never test by changing state, keys,
        // customer originals, queue entries, or an existing .new recovery file.
        var path = Path.Combine(directory, ".readiness-" + Guid.NewGuid().ToString("N"));
        try
        {
            var first = RandomNumberGenerator.GetBytes(32); AtomicWrite(path, first);
            if (!CryptographicOperations.FixedTimeEquals(first, LocalIo.Run("read_storage_probe", () => File.ReadAllBytes(path)))) throw new ConnectException("LOCAL_STORAGE_VERIFY_FAILED", "The storage write/read check failed. Existing evidence was not changed.");
            var replacement = RandomNumberGenerator.GetBytes(32); AtomicWrite(path, replacement);
            if (!CryptographicOperations.FixedTimeEquals(replacement, LocalIo.Run("read_replaced_storage_probe", () => File.ReadAllBytes(path)))) throw new ConnectException("LOCAL_STORAGE_VERIFY_FAILED", "The storage replacement check failed. Existing evidence was not changed.");
            LocalIo.Run("remove_storage_probe", () => File.Delete(path));
        }
        finally
        {
            // Only our two unpredictable scratch names may be cleaned up.
            foreach (var scratch in new[] { path, path + ".new" })
                try { File.Delete(scratch); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
    }
}
public sealed class EncryptedSpool(byte[] key)
{
    public byte[] Encrypt(byte[] bytes, string identity)
    {
        var nonce = RandomNumberGenerator.GetBytes(12); var tag = new byte[16]; var encrypted = new byte[bytes.Length];
        using var aes = new AesGcm(key, 16); aes.Encrypt(nonce, bytes, encrypted, tag, System.Text.Encoding.UTF8.GetBytes(identity));
        return [1, .. nonce, .. tag, .. encrypted];
    }
    public byte[] Decrypt(byte[] envelope, string identity)
    {
        if (envelope.Length < 29 || envelope[0] != 1) throw new ConnectException("SPOOL_INTEGRITY_FAILED", "A queued original could not be verified. Preserve it for recovery.");
        var bytes = new byte[envelope.Length - 29];
        try { using var aes = new AesGcm(key, 16); aes.Decrypt(envelope.AsSpan(1, 12), envelope.AsSpan(29), envelope.AsSpan(13, 16), bytes, System.Text.Encoding.UTF8.GetBytes(identity)); return bytes; }
        catch (CryptographicException) { throw new ConnectException("SPOOL_INTEGRITY_FAILED", "A queued original could not be verified. Preserve it for recovery."); }
    }
}
