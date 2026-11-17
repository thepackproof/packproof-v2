using Microsoft.Data.Sqlite;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

// CI fixture only. Not included in the application, service or installer.
// No caller-supplied storage path, no protected-key access and no spool reads.
internal static class Program
{
    private const string PartitionMigration = "e680cef33d86ffe6cf920c7a3740e3491872a32c";
    private const string BaseQueue = "CREATE TABLE queue(id TEXT PRIMARY KEY,digest TEXT NOT NULL,state TEXT NOT NULL,preview_key TEXT NOT NULL,commit_key TEXT NOT NULL,credential_generation TEXT NOT NULL,config_digest TEXT NOT NULL,import_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL,error_code TEXT,payload_path TEXT NOT NULL,";
    private const string PartitionColumns = "source_id TEXT NOT NULL DEFAULT 'legacy',source_profile TEXT NOT NULL DEFAULT 'shipment-csv/v1',grant_revision INTEGER NOT NULL DEFAULT 0,";
    private const string CommonColumns = "rowid,id,digest,state,preview_key,commit_key,credential_generation,config_digest,import_id,attempts,next_attempt_at,error_code,payload_path";
    public static int Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows() || Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" || Environment.GetEnvironmentVariable("APP_ENV") != "development" || args.Length != 1 || args[0] is not ("upgrade" or "verify")) throw new InvalidOperationException();
            var boundary = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            var root = Path.Combine(boundary, "PackProof", "Connect", "development");
            for (var path = root; path.Length >= boundary.Length; path = Path.GetDirectoryName(path)!)
            {
                AssertOrdinary(path, true);
                if (path.Equals(boundary, StringComparison.OrdinalIgnoreCase)) break;
            }
            foreach (var name in new[] { "state.bin", "spool-key.bin", "queue.sqlite" }) AssertOrdinary(Path.Combine(root, name), false);
            AssertOrdinary(Path.Combine(root, "spool"), true);
            foreach (var suffix in new[] { "-wal", "-shm" }) if (File.Exists(Path.Combine(root, "queue.sqlite" + suffix))) AssertOrdinary(Path.Combine(root, "queue.sqlite" + suffix), false);
            if (File.Exists(Path.Combine(root, "queue.sqlite-journal"))) throw new InvalidOperationException();
            using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(root, "queue.sqlite"), Mode = args[0] == "upgrade" ? SqliteOpenMode.ReadWrite : SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
            db.Open();
            var beforeVersion = args[0] == "upgrade" ? 1 : 4;
            var expectedVersion = args[0] == "upgrade" ? 2 : 4;
            Validate(db, beforeVersion);
            var before = Snapshot(db);
            if (args[0] == "upgrade")
            {
                using var tx = db.BeginTransaction();
                using var command = db.CreateCommand(); command.Transaction = tx;
                // Exact additive format written by the reviewed 0.2.0 source.
                command.CommandText = "ALTER TABLE queue ADD COLUMN source_id TEXT NOT NULL DEFAULT 'legacy'; ALTER TABLE queue ADD COLUMN source_profile TEXT NOT NULL DEFAULT 'shipment-csv/v1'; ALTER TABLE queue ADD COLUMN grant_revision INTEGER NOT NULL DEFAULT 0; UPDATE meta SET version=2;";
                command.ExecuteNonQuery();
                command.CommandText = "CREATE INDEX IF NOT EXISTS queue_source_due ON queue(source_id,credential_generation,config_digest,state,next_attempt_at); CREATE INDEX IF NOT EXISTS queue_source_page ON queue(source_id,id); PRAGMA user_version=2;";
                command.ExecuteNonQuery(); tx.Commit();
            }
            Validate(db, expectedVersion); var after = Snapshot(db);
            if (before.Count != 1 || before != after) throw new InvalidOperationException();
            Console.WriteLine(JsonSerializer.Serialize(new { schema = "packproof.ci-legacy-queue-upgrade/v2", partitionMigrationCommit = PartitionMigration, operation = args[0], beforeVersion, queueVersion = expectedVersion, rowCount = after.Count, metadataSha256 = after.Hash, metadataPreserved = true }));
            return 0;
        }
        catch
        {
            // A fixture failure must not disclose retained row values or paths.
            Console.Error.WriteLine("CI_QUEUE_UPGRADE_FIXTURE_FAILED: Guards, exact queue layout or preservation checks failed. No reset was attempted.");
            return 1;
        }
    }
    private static void Validate(SqliteConnection db, int expectedVersion)
    {
        using var command = db.CreateCommand();
        command.CommandText = "PRAGMA journal_mode"; if (!string.Equals(command.ExecuteScalar() as string, "wal", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
        command.CommandText = "PRAGMA user_version"; if (Convert.ToInt32(command.ExecuteScalar()) != expectedVersion) throw new InvalidOperationException();
        command.CommandText = "SELECT version FROM meta";
        using (var reader = command.ExecuteReader()) if (!reader.Read() || reader.GetFieldType(0) != typeof(long) || reader.GetInt32(0) != expectedVersion || reader.Read()) throw new InvalidOperationException();
        command.CommandText = "SELECT name FROM sqlite_master WHERE (type='table' AND name NOT LIKE 'sqlite_%') OR type IN ('trigger','view') ORDER BY name";
        var objects = new List<string>(); using (var reader = command.ExecuteReader()) while (reader.Read()) objects.Add(reader.GetString(0));
        string[] expectedObjects = expectedVersion == 4 ? ["meta", "queue", "queue_backfill_items", "queue_work"] : ["meta", "queue"];
        if (!objects.SequenceEqual(expectedObjects)) throw new InvalidOperationException();
        RequireSql(db, "meta", "CREATE TABLE meta(version INTEGER NOT NULL)");
        RequireSql(db, "queue", BaseQueue + (expectedVersion >= 2 ? PartitionColumns : "") + "UNIQUE(digest,config_digest))");
        var indexes = new Dictionary<string, bool> { ["sqlite_autoindex_queue_1"] = true, ["sqlite_autoindex_queue_2"] = true };
        if (expectedVersion >= 2)
        {
            indexes["queue_source_due"] = false; indexes["queue_source_page"] = false;
            RequireSql(db, "queue_source_due", "CREATE INDEX queue_source_due ON queue(source_id,credential_generation,config_digest,state,next_attempt_at)");
            RequireSql(db, "queue_source_page", "CREATE INDEX queue_source_page ON queue(source_id,id)");
            command.CommandText = "SELECT COUNT(*) FROM queue WHERE source_id!='legacy' OR source_profile!='shipment-csv/v1' OR grant_revision!=0";
            if (Convert.ToInt64(command.ExecuteScalar()) != 0) throw new InvalidOperationException();
        }
        if (expectedVersion == 4)
        {
            command.CommandText = "SELECT COUNT(*) FROM queue q JOIN queue_work w ON w.queue_id=q.id WHERE w.origin_lane='live' AND w.live_requested=1 AND w.created_at IS NULL AND q.import_id='ci-pending-receipt' AND q.state='awaiting_review'";
            if (Convert.ToInt64(command.ExecuteScalar()) != 1) throw new InvalidOperationException();
        }
        command.CommandText = "PRAGMA index_list(queue)";
        using (var reader = command.ExecuteReader()) while (reader.Read())
        {
            if (reader.GetInt32(4) != 0 || !indexes.Remove(reader.GetString(1), out var unique) || unique != (reader.GetInt32(2) == 1)) throw new InvalidOperationException();
        }
        if (indexes.Count != 0) throw new InvalidOperationException();
        command.CommandText = "PRAGMA quick_check(1)";
        using (var reader = command.ExecuteReader()) if (!reader.Read() || reader.GetString(0) != "ok" || reader.Read()) throw new InvalidOperationException();
    }
    private static void RequireSql(SqliteConnection db, string name, string expected)
    {
        using var command = db.CreateCommand(); command.CommandText = "SELECT sql FROM sqlite_master WHERE name=$name"; command.Parameters.AddWithValue("$name", name);
        static string Canonical(string sql) => Regex.Replace(sql, @"\s+", "").Replace("IFNOTEXISTS", "", StringComparison.OrdinalIgnoreCase).ToUpperInvariant();
        if (command.ExecuteScalar() is not string sql || Canonical(sql) != Canonical(expected)) throw new InvalidOperationException();
    }
    private static (int Count, string Hash) Snapshot(SqliteConnection db)
    {
        using var command = db.CreateCommand(); command.CommandText = "SELECT " + CommonColumns + " FROM queue ORDER BY rowid";
        var rows = new List<object?[]>(); using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            if (rows.Count >= 10000) throw new InvalidOperationException();
            rows.Add(Enumerable.Range(0, reader.FieldCount).Select(i => reader.IsDBNull(i) ? null : reader.GetValue(i)).ToArray());
        }
        return (rows.Count, Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(rows))));
    }
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation
    {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Serial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
    private static void AssertOrdinary(string path, bool directory)
    {
        using var handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x00200000 | 0x02000000, IntPtr.Zero);
        if (handle.IsInvalid || !GetFileInformationByHandle(handle, out var info) || (info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory || !directory && info.Links != 1) throw new InvalidOperationException();
    }
}
