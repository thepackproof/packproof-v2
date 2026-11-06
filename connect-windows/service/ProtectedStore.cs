using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
namespace PackProof.Connect;

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
    public static void Assert(string root, string boundary, string serviceSid)
    {
        var path = Path.GetFullPath(root).TrimEnd('\\'); var parentBoundary = Path.GetFullPath(boundary).TrimEnd('\\');
        if (!path.StartsWith(parentBoundary + "\\", StringComparison.OrdinalIgnoreCase)) throw Unsafe();
        var leaf = true;
        for (var directory = new DirectoryInfo(path); directory is not null; directory = directory.Parent)
        {
            if (!directory.Exists || (directory.Attributes & FileAttributes.ReparsePoint) != 0) throw Unsafe();
            AssertAcl(directory.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access), serviceSid, leaf);
            if (directory.FullName.TrimEnd('\\').Equals(parentBoundary, StringComparison.OrdinalIgnoreCase)) return;
            leaf = false;
        }
        throw Unsafe();
    }
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
        Directory.CreateDirectory(Root);
        var sample = RandomNumberGenerator.GetBytes(32);
        if (!CryptographicOperations.FixedTimeEquals(sample, protector.Unprotect(protector.Protect(sample)))) throw new ConnectException("PROTECTED_STORAGE_UNAVAILABLE", "Protected storage did not pass its service identity check.");
    }
    public T? Read<T>(string name) => File.Exists(Path.Combine(Root, name)) ? Json.Read<T>(protector.Unprotect(File.ReadAllBytes(Path.Combine(Root, name)))) : default;
    public void Write<T>(string name, T value) => AtomicWrite(Path.Combine(Root, name), protector.Protect(Json.Bytes(value)));
    public byte[] Key()
    {
        var existing = Read<byte[]>("spool-key.bin");
        if (existing is not null) return existing;
        if (File.Exists(Path.Combine(Root, "queue.sqlite")) || (Directory.Exists(Path.Combine(Root, "spool")) && Directory.EnumerateFiles(Path.Combine(Root, "spool")).Any()))
            throw new ConnectException("SPOOL_KEY_MISSING", "The retained queue has no protected encryption key. Preserve its files and contact support; a new empty queue will not be created.");
        var key = RandomNumberGenerator.GetBytes(32); Write("spool-key.bin", key); return key;
    }
    public static void AtomicWrite(string target, byte[] data)
    {
        var temp = target + ".new";
        using (var f = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { f.Write(data); f.Flush(true); }
        if (OperatingSystem.IsWindows())
        {
            // Persist the final name before SQLite can acknowledge a staged reference.
            if (!MoveFileEx(temp, target, 0x1 | 0x8)) throw new IOException("The protected file could not be durably replaced.", new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error()));
        }
        else File.Move(temp, target, true);
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
