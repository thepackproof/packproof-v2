using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;
using PackProof.Connect;
using Xunit;

public sealed class QueueSchemaCompatibilityTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "connect-schema-" + Guid.NewGuid().ToString("N"));
    private sealed class PlainProtector : ISecretProtector { public byte[] Protect(byte[] bytes) => bytes.ToArray(); public byte[] Unprotect(byte[] bytes) => bytes.ToArray(); }
    private ProtectedStore Store() { var store = new ProtectedStore(root, new PlainProtector()); store.Initialize(); return store; }
    private string Database => Path.Combine(root, "queue.sqlite");
    private static readonly byte[] Original = Encoding.UTF8.GetBytes("Shipment reference,Description,Quantity,Shipment date\n000123,Fixture original,12,2026-11-13T09:00:00-05:00\n");
    private static JsonElementBody Configuration() => new(Json.Element(new { integrationAccountId = "source-fixture", operatorMembershipId = "operator-fixture", sourceName = "Fixture", mapping = new { shipmentReference = "Shipment reference", itemTitle = "Description", quantity = "Quantity", shippedAt = "Shipment date" }, timeZone = "source-offset" }));
    private QueueEntry Fixture()
    {
        QueueEntry entry;
        using (var queue = new DurableQueue(Store()))
        {
            entry = queue.Stage(Original, "fixture.csv", Configuration(), "credential-fixture", "configuration-fixture", false);
            var payload = queue.Payload(entry);
            payload.PreservedFields = new() { ["futureReceiptPolicy"] = Json.Element(new { preserveExact = true, revision = 8 }) };
            payload.Receipt = Json.Element(new { id = "import-fixture", state = "previewed", original = new { sha256 = entry.Digest }, previewVersion = "version-fixture" });
            queue.Save(entry, payload, "awaiting_review", "import-fixture");
            entry = queue.Find(entry.Id)!; queue.Checkpoint();
        }
        ClearPool();
        // The v2 writer had the same partition columns and indexes and no
        // history-lane tables. Leave its real pending ciphertext untouched.
        Mutate("DROP TABLE queue_backfill_items; DROP TABLE queue_work; UPDATE meta SET version=2; PRAGMA user_version=2;");
        return entry;
    }
    private void ClearPool()
    {
        using var pool = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Database, Mode = SqliteOpenMode.ReadWriteCreate }.ToString()); SqliteConnection.ClearPool(pool);
    }
    private void Mutate(string sql)
    {
        using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Database, Pooling = false }.ToString()); db.Open(); using var command = db.CreateCommand(); command.CommandText = sql; command.ExecuteNonQuery();
    }
    private static string HashFixtureFile(string path)
    {
        // The WAL authority fixture deliberately keeps its SQLite writer open.
        // Observe stable committed bytes with Windows-compatible sharing; do
        // not close/checkpoint that writer merely to make the snapshot easier.
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[8192]; var total = 0; int read;
        while ((read = stream.Read(buffer)) != 0)
        {
            total += read; if (total > 16 * 1024 * 1024) throw new InvalidOperationException("The synthetic queue fixture exceeds its bounded snapshot budget.");
            digest.AppendData(buffer, 0, read);
        }
        return Convert.ToHexString(digest.GetHashAndReset());
    }
    private Dictionary<string, string> Snapshot() => Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).ToDictionary(path => Path.GetRelativePath(root, path), path => Path.GetFileName(path) == "queue.sqlite-shm" ? "sqlite-reader-coordination" : HashFixtureFile(path));
    private void AssertSnapshot(Dictionary<string, string> expected)
    {
        var observed = Snapshot();
        foreach (var pair in expected) { Assert.True(observed.ContainsKey(pair.Key)); Assert.Equal(pair.Value, observed[pair.Key]); }
        foreach (var extra in observed.Keys.Except(expected.Keys))
        {
            Assert.Contains(extra, new[] { "queue.sqlite-wal", "queue.sqlite-shm" });
            if (extra == "queue.sqlite-wal") Assert.Equal(0, new FileInfo(Path.Combine(root, extra)).Length);
        }
    }
    private (int User, int Meta) Versions()
    {
        using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Database, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString()); db.Open(); using var command = db.CreateCommand(); command.CommandText = "PRAGMA user_version"; var user = Convert.ToInt32(command.ExecuteScalar()); command.CommandText = "SELECT version FROM meta"; return (user, Convert.ToInt32(command.ExecuteScalar()));
    }
    [Fact]
    public void Exact_020_legacy_queue_continues_without_downgrading_markers_or_rewriting_originals()
    {
        var expected = Fixture(); var before = Snapshot(); byte[] wire; string? wireDigest;
        using (var queue = new DurableQueue(Store()))
        {
            var observed = queue.Find(expected.Id); Assert.Equal(expected, observed); var payload = queue.Payload(observed!);
            Assert.Equal(Original, Encoding.UTF8.GetBytes(payload.Csv)); Assert.Equal("import-fixture", payload.Receipt!.Value.GetProperty("id").GetString());
            Assert.True(payload.PreservedFields!["futureReceiptPolicy"].GetProperty("preserveExact").GetBoolean());
            wire = payload.PreviewWireBody!; wireDigest = payload.PreviewBodySha256;
        }
        ClearPool();
        var after = Snapshot();
        foreach (var pair in before.Where(p => p.Key.StartsWith("spool" + Path.DirectorySeparatorChar) || p.Key == "spool-key.bin"))
            Assert.Equal(pair.Value, after[pair.Key]);
        Assert.Equal((4, 4), Versions());
        using (var queue = new DurableQueue(Store()))
        {
            var payload = queue.Payload(queue.Find(expected.Id)!); queue.Save(expected, payload, "awaiting_review", "import-fixture", error: "FIXTURE_RETRY");
            var retried = queue.Find(expected.Id)!;
            Assert.Equal(expected.PreviewKey, retried.PreviewKey); Assert.Equal(expected.CommitKey, retried.CommitKey); Assert.Equal(expected.CredentialGeneration, retried.CredentialGeneration); Assert.Equal(expected.ConfigDigest, retried.ConfigDigest); Assert.Equal(expected.Digest, retried.Digest);
            var saved = queue.Payload(retried); Assert.Equal(wire, saved.PreviewWireBody); Assert.Equal(wireDigest, saved.PreviewBodySha256); Assert.Equal("import-fixture", saved.Receipt!.Value.GetProperty("id").GetString()); Assert.Equal(8, saved.PreservedFields!["futureReceiptPolicy"].GetProperty("revision").GetInt32());
            var next = queue.Stage(Encoding.UTF8.GetBytes("second original"), "second.csv", Configuration(), "credential-fixture", "configuration-fixture", false); Assert.NotEqual(expected.Id, next.Id); queue.Checkpoint();
        }
        ClearPool(); Assert.Equal((4, 4), Versions());
        using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Database, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString()); db.Open(); using var command = db.CreateCommand(); command.CommandText = "SELECT COUNT(*) FROM queue WHERE source_id='legacy' AND source_profile='shipment-csv/v1' AND grant_revision=0"; Assert.Equal(2L, command.ExecuteScalar());
    }
    [Theory]
    [InlineData("UPDATE queue SET source_id='typed-source'", "QUEUE_SOURCE_RUNTIME_REQUIRED")]
    [InlineData("UPDATE queue SET source_profile='order-csv/v1'", "QUEUE_SOURCE_RUNTIME_REQUIRED")]
    [InlineData("UPDATE queue SET grant_revision=1", "QUEUE_SOURCE_RUNTIME_REQUIRED")]
    [InlineData("UPDATE queue SET state='complete',source_id='typed-source'", "QUEUE_SOURCE_RUNTIME_REQUIRED")]
    [InlineData("PRAGMA user_version=4;UPDATE meta SET version=4", "QUEUE_SCHEMA_UNSUPPORTED")]
    [InlineData("PRAGMA user_version=99;UPDATE meta SET version=99", "QUEUE_SCHEMA_UNSUPPORTED")]
    [InlineData("UPDATE meta SET version=1", "QUEUE_SCHEMA_UNSUPPORTED")]
    [InlineData("PRAGMA user_version=1;UPDATE meta SET version=1", "QUEUE_SCHEMA_UNSUPPORTED")]
    [InlineData("PRAGMA user_version=0;UPDATE meta SET version=1", "QUEUE_SCHEMA_UNSUPPORTED")]
    [InlineData("INSERT INTO meta(version) VALUES(2)", "QUEUE_SCHEMA_UNSUPPORTED")]
    [InlineData("ALTER TABLE queue ADD COLUMN unknown_authority TEXT", "QUEUE_SCHEMA_UNSUPPORTED")]
    [InlineData("CREATE TABLE queue_work(queue_id TEXT PRIMARY KEY)", "QUEUE_SCHEMA_UNSUPPORTED")]
    [InlineData("CREATE TRIGGER hidden_update AFTER UPDATE ON queue BEGIN UPDATE meta SET version=3; END", "QUEUE_SCHEMA_UNSUPPORTED")]
    [InlineData("DROP INDEX queue_source_page", "QUEUE_SCHEMA_UNSUPPORTED")]
    [InlineData("DROP INDEX queue_source_due;CREATE INDEX queue_source_due ON queue(source_id DESC,credential_generation,config_digest,state,next_attempt_at)", "QUEUE_SCHEMA_UNSUPPORTED")]
    public void Unsupported_source_or_layout_is_rejected_without_changing_retained_bytes(string mutation, string code)
    {
        Fixture(); Mutate(mutation); var before = Snapshot();
        Assert.Equal(code, Assert.Throws<ConnectException>(() => new DurableQueue(new ProtectedStore(root, new PlainProtector()))).Code);
        ClearPool(); AssertSnapshot(before);
    }
    [Theory]
    [InlineData(3)]
    [InlineData(4)]
    public void Shipment_only_reader_refuses_newer_schema_with_pending_work(int version)
    {
        Fixture(); Mutate($"UPDATE meta SET version={version}; PRAGMA user_version={version};");
        var before = Snapshot();
        using (var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Database, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString()))
        {
            db.Open();
            Assert.Equal("QUEUE_SCHEMA_UNSUPPORTED", Assert.Throws<ConnectException>(() => QueueSchemaCompatibility.Inspect(db, sourceAware: false)).Code);
        }
        AssertSnapshot(before);
    }
    [Theory]
    [InlineData("DELETE FROM queue_work")]
    [InlineData("UPDATE queue_work SET live_requested=0")]
    [InlineData("CREATE TABLE unknown_work(queue_id TEXT PRIMARY KEY)")]
    public void Current_queue_with_missing_or_unknown_scheduling_authority_is_preserved_for_review(string mutation)
    {
        Fixture();
        using (var current = new DurableQueue(Store())) Assert.Single(current.Entries());
        ClearPool(); Mutate(mutation);
        var before=Snapshot();
        Assert.Equal("QUEUE_SCHEMA_UNSUPPORTED", Assert.Throws<ConnectException>(() => new DurableQueue(Store())).Code);
        ClearPool(); AssertSnapshot(before);
    }
    [Fact]
    public void Source_identity_committed_only_in_WAL_is_honored_and_preserved()
    {
        Fixture();
        using var writer = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Database, Pooling = false }.ToString()); writer.Open();
        using var command = writer.CreateCommand(); command.CommandText = "PRAGMA wal_autocheckpoint=0;UPDATE queue SET source_id='typed-in-wal'"; command.ExecuteNonQuery();
        Assert.True(new FileInfo(Database + "-wal").Length > 0);
        var before = Snapshot();
        Assert.Equal("QUEUE_SOURCE_RUNTIME_REQUIRED", Assert.Throws<ConnectException>(() => new DurableQueue(new ProtectedStore(root, new PlainProtector()))).Code);
        AssertSnapshot(before);
    }
    [Theory]
    [InlineData("{\"stateVersion\":2,\"StateVersion\":4}")]
    [InlineData("{\"sourceSubscriptions\":[],\"SourceSubscriptions\":[{\"id\":\"typed\"}]}")]
    [InlineData("{\"sourceSubscriptions\":[{\"id\":\"legacy\",\"ID\":\"typed\",\"sourceProfile\":\"shipment-csv/v1\"}]}")]
    public void Ambiguous_case_aliases_cannot_hide_source_or_future_state(string json)
    {
        Assert.Equal("LOCAL_STATE_UNSUPPORTED", Assert.Throws<ConnectException>(() => Json.Read<LocalState>(Encoding.UTF8.GetBytes(json))).Code);
    }
    public void Dispose() { ClearPool(); if (Directory.Exists(root)) Directory.Delete(root, true); }
}
