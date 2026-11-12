using System.ComponentModel;
using System.Security.Cryptography;
using PackProof.Connect;
using Xunit;
namespace PackProof.Connect.Tests;

public sealed class StorageReadinessTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "packproof-storage-test-" + Guid.NewGuid().ToString("N"));
    private sealed class PlainTestProtector : ISecretProtector
    {
        public byte[] Protect(byte[] bytes) => bytes.ToArray();
        public byte[] Unprotect(byte[] bytes) => bytes.ToArray();
    }
    private ProtectedStore Store() => new(root, new PlainTestProtector());
    public StorageReadinessTests() => Directory.CreateDirectory(root);
    public void Dispose() { Directory.Delete(root, true); }
    [Fact] public void Initialization_exercises_disk_without_creating_state_or_keys()
    {
        Store().Initialize(); Assert.Empty(Directory.EnumerateFileSystemEntries(root));
    }
    [Fact] public void Probe_preserves_existing_files_and_recovery_temporary_bytes()
    {
        var originals = new Dictionary<string, byte[]>();
        foreach (var name in new[] { "state.bin", "spool-key.bin", "queue.sqlite", "state.bin.new" })
        { var bytes = RandomNumberGenerator.GetBytes(64); originals[name] = bytes; File.WriteAllBytes(Path.Combine(root, name), bytes); }
        ProtectedStore.ProbeDirectory(root);
        foreach (var file in originals) Assert.Equal(file.Value, File.ReadAllBytes(Path.Combine(root, file.Key)));
        Assert.Equal(originals.Count, Directory.EnumerateFiles(root).Count());
    }
    [Fact] public void Missing_state_is_distinct_from_malformed_existing_state()
    {
        Assert.Null(Store().Read<LocalState>("state.bin"));
        File.WriteAllText(Path.Combine(root, "state.bin"), "not-json");
        Assert.Equal("LOCAL_STATE_INVALID", Assert.Throws<ConnectException>(() => Store().Read<LocalState>("state.bin")).Code);
        Assert.Equal("not-json", File.ReadAllText(Path.Combine(root, "state.bin")));
    }
    [Fact] public void Directory_at_state_path_cannot_be_treated_as_absence()
    {
        Directory.CreateDirectory(Path.Combine(root, "state.bin"));
        Assert.Equal("PROTECTED_STORAGE_LINK", Assert.Throws<ConnectException>(() => Store().Read<LocalState>("state.bin")).Code);
    }
    [Fact] public void Retained_queue_without_key_is_never_reset()
    {
        var original = RandomNumberGenerator.GetBytes(128); File.WriteAllBytes(Path.Combine(root, "queue.sqlite"), original);
        Assert.Equal("SPOOL_KEY_MISSING", Assert.Throws<ConnectException>(() => Store().Key()).Code);
        Assert.False(File.Exists(Path.Combine(root, "spool-key.bin"))); Assert.Equal(original, File.ReadAllBytes(Path.Combine(root, "queue.sqlite")));
    }
    [Fact] public void Invalid_existing_key_is_never_replaced()
    {
        Store().Write("spool-key.bin", new byte[7]); var before = File.ReadAllBytes(Path.Combine(root, "spool-key.bin"));
        Assert.Equal("SPOOL_KEY_INVALID", Assert.Throws<ConnectException>(() => Store().Key()).Code);
        Assert.Equal(before, File.ReadAllBytes(Path.Combine(root, "spool-key.bin")));
    }
    [Fact] public void Locked_key_is_not_missing_and_keeps_exact_bytes()
    {
        if (!OperatingSystem.IsWindows()) return;
        var key = Store().Key(); var path = Path.Combine(root, "spool-key.bin"); var before = File.ReadAllBytes(path);
        using (var held = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            Assert.Equal("LOCAL_STORAGE_BUSY", Assert.Throws<ConnectException>(() => Store().Key()).Code);
        Assert.Equal(before, File.ReadAllBytes(path)); Assert.Equal(key, Store().Key()); Assert.False(File.Exists(path + ".new"));
    }
    [Fact] public void Missing_storage_root_is_not_silently_recreated_during_read()
    {
        Directory.Delete(root);
        try { Assert.Equal("LOCAL_STORAGE_PATH_MISSING", Assert.Throws<ConnectException>(() => Store().Read<LocalState>("state.bin")).Code); }
        finally { Directory.CreateDirectory(root); }
    }
    [Fact] public void Access_error_has_operation_without_private_path()
    {
        var failure = LocalIo.Failure(new UnauthorizedAccessException(@"Denied C:\Private\customer-secret.csv"), "read_protected_state");
        Assert.Equal("LOCAL_STORAGE_ACCESS_DENIED", failure.Code); Assert.Contains("read_protected_state", failure.Message); Assert.DoesNotContain("Private", failure.Message); Assert.DoesNotContain("customer-secret", failure.Message);
    }
    [Theory][InlineData(112,"LOCAL_STORAGE_FULL")][InlineData(39,"LOCAL_STORAGE_FULL")][InlineData(32,"LOCAL_STORAGE_BUSY")][InlineData(33,"LOCAL_STORAGE_BUSY")][InlineData(5,"LOCAL_STORAGE_ACCESS_DENIED")][InlineData(1117,"LOCAL_STORAGE_IO_FAILED")]
    public void Native_failure_classification_is_specific(int code, string expected)
    { Assert.Equal(expected, LocalIo.Failure(new IOException("private path", new Win32Exception(code)), "write_probe").Code); }
    [Fact] public void Transient_lock_retry_is_bounded_and_can_recover()
    {
        var attempts = 0;
        Assert.Equal(3, LocalIo.Run("test_write", () => { if (++attempts < 3) throw new IOException("locked", new Win32Exception(32)); return attempts; }));
        attempts = 0;
        Assert.Equal("LOCAL_STORAGE_BUSY", Assert.Throws<ConnectException>(() => LocalIo.Run<int>("test_write", () => { attempts++; throw new IOException("locked", new Win32Exception(32)); })).Code);
        Assert.Equal(3, attempts);
    }
    [Fact] public void Permission_failure_is_not_retried_or_weakened()
    {
        var attempts = 0;
        Assert.Equal("LOCAL_STORAGE_ACCESS_DENIED", Assert.Throws<ConnectException>(() => LocalIo.Run<int>("test_read", () => { attempts++; throw new UnauthorizedAccessException(); })).Code);
        Assert.Equal(1, attempts);
    }
    [Fact] public void Source_permission_error_is_not_internal_storage_failure()
    {
        var error = Assert.Throws<ConnectException>(() => FolderSource.SourceRead<int>(() => throw new UnauthorizedAccessException(@"C:\Private\customer.csv")));
        Assert.Equal("SOURCE_ACCESS_DENIED", error.Code); Assert.Contains("prepared PackProof Exports folder", error.Message); Assert.DoesNotContain("customer.csv", error.Message);
    }
    [Fact] public void Source_lock_error_is_actionable_without_paths()
    {
        var error = Assert.Throws<ConnectException>(() => FolderSource.SourceRead<int>(() => throw new IOException("private shipment", new Win32Exception(32))));
        Assert.Equal("SOURCE_BUSY", error.Code); Assert.DoesNotContain("private shipment", error.Message);
    }
    [Fact] public void Missing_source_is_distinct_from_missing_protected_storage()
    {
        Assert.Equal("SOURCE_NOT_FOUND", Assert.Throws<ConnectException>(() => FolderSource.SourceRead<int>(() => throw new DirectoryNotFoundException())).Code);
        Assert.Equal("SOURCE_NOT_FOUND", Assert.Throws<ConnectException>(() => FolderSource.SourceRead<int>(() => throw new FileNotFoundException())).Code);
    }
    [Fact] public void Other_source_io_errors_stay_in_source_domain()
    { Assert.Equal("SOURCE_READ_FAILED", Assert.Throws<ConnectException>(() => FolderSource.SourceRead<int>(() => throw new IOException())).Code); }
    [Fact] public void Existing_source_integrity_errors_keep_their_identity()
    {
        var original = new ConnectException("SOURCE_CHANGED", "Original changed.");
        Assert.Same(original, Assert.Throws<ConnectException>(() => FolderSource.SourceRead<int>(() => throw original)));
    }
}
