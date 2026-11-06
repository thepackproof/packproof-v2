using Microsoft.Data.Sqlite;
using System.Text.Json;
using System.Security.Cryptography;
namespace PackProof.Connect;

public sealed class DurableQueue : IDisposable
{
    private readonly SqliteConnection db;
    private readonly string spoolRoot;
    private readonly EncryptedSpool encryption;
    public const long MaxSpoolBytes = 1024L * 1024 * 1024;
    public const long DiskReserveBytes = 1024L * 1024 * 1024;
    public const int MaxFiles = 10000;
    public DurableQueue(ProtectedStore store)
    {
        spoolRoot = Path.Combine(store.Root, "spool"); Directory.CreateDirectory(spoolRoot); encryption = new(store.Key());
        db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(store.Root, "queue.sqlite"), Mode = SqliteOpenMode.ReadWriteCreate }.ToString()); db.Open();
        try
        {
            using (var compatibility = db.CreateCommand()) { compatibility.CommandText = "PRAGMA user_version"; if (Convert.ToInt32(compatibility.ExecuteScalar()) > 1) throw new ConnectException("QUEUE_SCHEMA_UNSUPPORTED", "Install the compatible PackProof version to preserve this queue."); compatibility.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='meta'"; if (Convert.ToInt32(compatibility.ExecuteScalar()) > 0) { compatibility.CommandText = "SELECT version FROM meta"; if (Convert.ToInt32(compatibility.ExecuteScalar()) != 1) throw new ConnectException("QUEUE_SCHEMA_UNSUPPORTED", "Install the compatible PackProof version to preserve this queue."); } }
            Execute("PRAGMA user_version=1; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS meta (version INTEGER NOT NULL); INSERT INTO meta(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM meta); CREATE TABLE IF NOT EXISTS queue(id TEXT PRIMARY KEY,digest TEXT NOT NULL,state TEXT NOT NULL,preview_key TEXT NOT NULL,commit_key TEXT NOT NULL,credential_generation TEXT NOT NULL,config_digest TEXT NOT NULL,import_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL,error_code TEXT,payload_path TEXT NOT NULL,UNIQUE(digest,config_digest));");
            using var v = db.CreateCommand(); v.CommandText = "SELECT version FROM meta"; if (Convert.ToInt32(v.ExecuteScalar()) != 1) throw new ConnectException("QUEUE_SCHEMA_UNSUPPORTED", "This version cannot read the queued work. Install the compatible PackProof version.");
            foreach (var entry in Entries()) if (!File.Exists(Path.Combine(spoolRoot, entry.PayloadPath))) throw new ConnectException("SPOOL_ORIGINAL_MISSING", "A queue entry is missing its encrypted original. Preserve the remaining queue and contact support.");
            // Unreferenced .new/.bin files are retained as recoverable orphans; never counted as safe committed work.
        }
        catch { db.Dispose(); throw; }
    }
    private void Execute(string sql) { using var c = db.CreateCommand(); c.CommandText = sql; c.ExecuteNonQuery(); }
    public IReadOnlyList<QueueEntry> Entries()
    {
        using var c = db.CreateCommand(); c.CommandText = "SELECT id,digest,state,preview_key,commit_key,credential_generation,config_digest,import_id,attempts,next_attempt_at,error_code,payload_path FROM queue ORDER BY rowid";
        using var r = c.ExecuteReader(); var result = new List<QueueEntry>(); while (r.Read()) result.Add(new(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetString(5), r.GetString(6), r.IsDBNull(7) ? null : r.GetString(7), r.GetInt32(8), DateTimeOffset.Parse(r.GetString(9)), r.IsDBNull(10) ? null : r.GetString(10), r.GetString(11))); return result;
    }
    public int OrphanCount { get { var referenced = Entries().Select(x => x.PayloadPath).ToHashSet(StringComparer.OrdinalIgnoreCase); return Directory.EnumerateFiles(spoolRoot).Count(x => !referenced.Contains(Path.GetFileName(x))); } }
    public QueueEntry? Find(string id) => Entries().FirstOrDefault(x => x.Id == id);
    public QueuePayload Payload(QueueEntry entry) => Json.Read<QueuePayload>(encryption.Decrypt(File.ReadAllBytes(Path.Combine(spoolRoot, entry.PayloadPath)), entry.Id));
    public QueueEntry Stage(byte[] bytes, string fileName, JsonElementBody body, string generation, string configDigest, bool commitApproved)
    {
        var digest = Convert.ToHexStringLower(SHA256.HashData(bytes)); var existing = Entries().FirstOrDefault(x => x.Digest == digest && x.ConfigDigest == configDigest); if (existing is not null) return existing;
        var utf8 = new System.Text.UTF8Encoding(false, true); string csv; try { csv = utf8.GetString(bytes); } catch (System.Text.DecoderFallbackException) { throw new ConnectException("CSV_ENCODING_UNSUPPORTED", "Save the source export as UTF-8 CSV."); }
        var payload = new QueuePayload { FileName = fileName, Csv = csv, PreviewBody = body.Build(csv), CommitApproved = commitApproved }; payload.PreviewWireBody = Json.Bytes(payload.PreviewBody); payload.PreviewBodySha256 = Convert.ToHexStringLower(SHA256.HashData(payload.PreviewWireBody)); var id = Guid.NewGuid().ToString("N"); var path = id + ".bin"; var encrypted = encryption.Encrypt(Json.Bytes(payload), id);
        var files = Directory.EnumerateFiles(spoolRoot).Select(x => new FileInfo(x)).ToArray(); var free = new DriveInfo(Path.GetPathRoot(spoolRoot)!).AvailableFreeSpace;
        if (files.Length >= MaxFiles || files.Sum(x => x.Length) + encrypted.Length > MaxSpoolBytes || free - encrypted.Length < DiskReserveBytes) throw new ConnectException("SPOOL_CAPACITY_REACHED", "Collection paused to preserve queued originals. Free approved disk space or resolve pending imports.");
        ProtectedStore.AtomicWrite(Path.Combine(spoolRoot, path), encrypted);
        using var tx = db.BeginTransaction(); using var c = db.CreateCommand(); c.Transaction = tx; c.CommandText = "INSERT INTO queue(id,digest,state,preview_key,commit_key,credential_generation,config_digest,next_attempt_at,payload_path) VALUES($id,$digest,'staged',$preview,$commit,$generation,$config,$next,$path)";
        c.Parameters.AddWithValue("$id", id); c.Parameters.AddWithValue("$digest", digest); c.Parameters.AddWithValue("$preview", Guid.NewGuid().ToString("N")); c.Parameters.AddWithValue("$commit", Guid.NewGuid().ToString("N")); c.Parameters.AddWithValue("$generation", generation); c.Parameters.AddWithValue("$config", configDigest); c.Parameters.AddWithValue("$next", DateTimeOffset.UtcNow.ToString("O")); c.Parameters.AddWithValue("$path", path); c.ExecuteNonQuery(); tx.Commit(); return Find(id)!;
    }
    public void Save(QueueEntry entry, QueuePayload payload, string state, string? importId = null, string? error = null, bool failed = false, TimeSpan? retryAfter = null)
    {
        ProtectedStore.AtomicWrite(Path.Combine(spoolRoot, entry.PayloadPath), encryption.Encrypt(Json.Bytes(payload), entry.Id));
        var attempts = failed ? entry.Attempts + 1 : entry.Attempts; var delay = failed ? retryAfter ?? TimeSpan.FromSeconds(Math.Min(300, 2 * Math.Pow(2, Math.Min(attempts, 8))) + Random.Shared.NextDouble() * 2) : TimeSpan.Zero;
        using var tx = db.BeginTransaction(); using var c = db.CreateCommand(); c.Transaction = tx; c.CommandText = "UPDATE queue SET state=$state,import_id=$import,attempts=$attempts,next_attempt_at=$next,error_code=$error WHERE id=$id";
        c.Parameters.AddWithValue("$state", state); c.Parameters.AddWithValue("$import", (object?)importId ?? entry.ImportId ?? (object)DBNull.Value); c.Parameters.AddWithValue("$attempts", attempts); c.Parameters.AddWithValue("$next", DateTimeOffset.UtcNow.Add(delay).ToString("O")); c.Parameters.AddWithValue("$error", (object?)error ?? DBNull.Value); c.Parameters.AddWithValue("$id", entry.Id); c.ExecuteNonQuery(); tx.Commit();
    }
    public void Checkpoint() => Execute("PRAGMA wal_checkpoint(FULL)");
    public void Dispose() => db.Dispose();
}
public sealed record JsonElementBody(System.Text.Json.JsonElement Config)
{
    public System.Text.Json.JsonElement Build(string csv) => Json.Element(new { integrationAccountId = Config.GetProperty("integrationAccountId").GetString(), operatorMembershipId = Config.GetProperty("operatorMembershipId").GetString(), sourceName = Config.GetProperty("sourceName").GetString(), mapping = Config.GetProperty("mapping"), timeZone = Config.GetProperty("timeZone").GetString(), csv });
}
