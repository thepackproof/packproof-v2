using Microsoft.Data.Sqlite;
using System.Text.Json;
using System.Security.Cryptography;
namespace PackProof.Connect;

public sealed partial class DurableQueue : IDisposable
{
    private readonly SqliteConnection db;
    private readonly string spoolRoot;
    private readonly EncryptedSpool encryption;
    private readonly int originalFileLimit;
    public const long MaxSpoolBytes = 1024L * 1024 * 1024;
    public const long DiskReserveBytes = 1024L * 1024 * 1024;
    public const int MaxFiles = 10000;
    public DurableQueue(ProtectedStore store) : this(store, MaxFiles) { }
    internal DurableQueue(ProtectedStore store, int originalFileLimit)
    {
        if (originalFileLimit is < 1 or > MaxFiles) throw new ArgumentOutOfRangeException(nameof(originalFileLimit));
        this.originalFileLimit = originalFileLimit;
        spoolRoot = Path.Combine(store.Root, "spool"); Directory.CreateDirectory(spoolRoot); encryption = new(store.Key());
        db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(store.Root, "queue.sqlite"), Mode = SqliteOpenMode.ReadWriteCreate }.ToString()); db.Open();
        try
        {
            InitializeSchema();
            foreach (var entry in Entries()) if (!File.Exists(Path.Combine(spoolRoot, entry.PayloadPath))) throw new ConnectException("SPOOL_ORIGINAL_MISSING", "A queue entry is missing its encrypted original. Preserve the remaining queue and contact support.");
            // Unreferenced .new/.bin files are retained as recoverable orphans; never counted as safe committed work.
        }
        catch { db.Dispose(); throw; }
    }
    private void Execute(string sql) { using var c = db.CreateCommand(); c.CommandText = sql; c.ExecuteNonQuery(); }
    private const string Columns = "id,digest,state,preview_key,commit_key,credential_generation,config_digest,import_id,attempts,next_attempt_at,error_code,payload_path,source_id,source_profile,grant_revision";
    private void InitializeSchema()
    {
        using var command = db.CreateCommand(); command.CommandText = "PRAGMA user_version";
        var userVersion = Convert.ToInt32(command.ExecuteScalar());
        if (userVersion > 4) throw new ConnectException("QUEUE_SCHEMA_UNSUPPORTED", "Install the compatible PackProof version to preserve this queue.");
        command.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='meta'";
        var hasMeta = Convert.ToInt32(command.ExecuteScalar()) > 0;
        if (hasMeta)
        {
            command.CommandText = "SELECT version FROM meta"; var values = new List<int>();
            using (var reader = command.ExecuteReader()) while (reader.Read()) values.Add(reader.GetInt32(0));
            if (values.Count != 1 || values[0] is < 1 or > 4 || (userVersion != 0 && values[0] != userVersion)) throw new ConnectException("QUEUE_SCHEMA_UNSUPPORTED", "Install the compatible PackProof version to preserve this queue.");
        }
        Execute("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;");
        using var transaction = db.BeginTransaction(); command.Transaction = transaction;
        command.CommandText = "CREATE TABLE IF NOT EXISTS meta (version INTEGER NOT NULL); INSERT INTO meta(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM meta); CREATE TABLE IF NOT EXISTS queue(id TEXT PRIMARY KEY,digest TEXT NOT NULL,state TEXT NOT NULL,preview_key TEXT NOT NULL,commit_key TEXT NOT NULL,credential_generation TEXT NOT NULL,config_digest TEXT NOT NULL,import_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL,error_code TEXT,payload_path TEXT NOT NULL,UNIQUE(digest,config_digest));";
        command.ExecuteNonQuery(); command.CommandText = "SELECT version FROM meta"; var version = Convert.ToInt32(command.ExecuteScalar());
        if (version == 1)
        {
            // Pending originals, encrypted payloads, stable keys and old authority
            // are unchanged. The sentinel is a legacy lane, never a new grant.
            command.CommandText = "ALTER TABLE queue ADD COLUMN source_id TEXT NOT NULL DEFAULT 'legacy'; ALTER TABLE queue ADD COLUMN source_profile TEXT NOT NULL DEFAULT 'shipment-csv/v1'; ALTER TABLE queue ADD COLUMN grant_revision INTEGER NOT NULL DEFAULT 0; UPDATE meta SET version=2;"; command.ExecuteNonQuery();
        }
        // Version four adds source/job scheduling metadata and retains the
        // earlier identity/permit barrier. Existing encrypted originals, wire
        // bodies, stable keys and capture ownership remain exact; capture time
        // is deliberately NULL for rows written by older binaries.
        command.CommandText="CREATE TABLE IF NOT EXISTS queue_work(queue_id TEXT PRIMARY KEY REFERENCES queue(id),origin_lane TEXT NOT NULL CHECK(origin_lane IN ('live','backfill')),live_requested INTEGER NOT NULL,created_at TEXT,original_byte_size INTEGER); INSERT INTO queue_work(queue_id,origin_lane,live_requested) SELECT id,'live',1 FROM queue WHERE id NOT IN(SELECT queue_id FROM queue_work); CREATE TABLE IF NOT EXISTS queue_backfill_items(job_id TEXT NOT NULL,item_id TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,queue_id TEXT REFERENCES queue(id),error_code TEXT,PRIMARY KEY(job_id,item_id)); UPDATE meta SET version=4";command.ExecuteNonQuery();
        command.CommandText = "CREATE INDEX IF NOT EXISTS queue_source_due ON queue(source_id,credential_generation,config_digest,state,next_attempt_at); CREATE INDEX IF NOT EXISTS queue_source_page ON queue(source_id,id); PRAGMA user_version=4;"; command.ExecuteNonQuery(); transaction.Commit();
    }
    private static QueueEntry ReadEntry(SqliteDataReader r) => new(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetString(5), r.GetString(6), r.IsDBNull(7) ? null : r.GetString(7), r.GetInt32(8), DateTimeOffset.Parse(r.GetString(9)), r.IsDBNull(10) ? null : r.GetString(10), r.GetString(11), r.GetString(12), r.GetString(13), r.GetInt32(14));
    private IReadOnlyList<QueueEntry> ReadEntries(SqliteCommand command)
    {
        using var reader = command.ExecuteReader(); var result = new List<QueueEntry>(); while (reader.Read()) result.Add(ReadEntry(reader)); return result;
    }
    public IReadOnlyList<QueueEntry> Entries()
    {
        using var command = db.CreateCommand(); command.CommandText = $"SELECT {Columns} FROM queue ORDER BY rowid"; return ReadEntries(command);
    }
    public IReadOnlyList<QueueEntry> Page(string sourceId, string? afterId = null, int limit = 100, string? generation = null, string? configuration = null, bool pendingOnly = false)
    {
        if (limit is < 1 or > 200) throw new ArgumentOutOfRangeException(nameof(limit));
        using var command = db.CreateCommand(); command.CommandText = $"SELECT {Columns} FROM queue WHERE source_id=$source AND ($after IS NULL OR id>$after) AND ($generation IS NULL OR credential_generation=$generation) AND ($configuration IS NULL OR config_digest=$configuration) AND ($pending=0 OR state!='complete') ORDER BY id LIMIT $limit";
        command.Parameters.AddWithValue("$source", sourceId); command.Parameters.AddWithValue("$after", (object?)afterId ?? DBNull.Value); command.Parameters.AddWithValue("$generation", (object?)generation ?? DBNull.Value); command.Parameters.AddWithValue("$configuration", (object?)configuration ?? DBNull.Value); command.Parameters.AddWithValue("$pending", pendingOnly ? 1 : 0); command.Parameters.AddWithValue("$limit", limit); return ReadEntries(command);
    }
    public QueueEntry? NextDue(string sourceId, string generation, string configuration, DateTimeOffset now)
    {
        using var command = db.CreateCommand(); command.CommandText = $"SELECT {Columns} FROM queue WHERE source_id=$source AND credential_generation=$generation AND config_digest=$configuration AND state NOT IN ('complete','partial','action_needed','awaiting_review') AND next_attempt_at<=$now ORDER BY next_attempt_at,rowid LIMIT 1";
        command.Parameters.AddWithValue("$source", sourceId); command.Parameters.AddWithValue("$generation", generation); command.Parameters.AddWithValue("$configuration", configuration); command.Parameters.AddWithValue("$now", now.ToString("O")); return ReadEntries(command).FirstOrDefault();
    }
    public Dictionary<string,int> Counts(string? sourceId = null, string? generation = null, string? configuration = null)
    {
        using var command = db.CreateCommand(); command.CommandText = "SELECT state,COUNT(*) FROM queue WHERE ($source IS NULL OR source_id=$source) AND ($generation IS NULL OR credential_generation=$generation) AND ($configuration IS NULL OR config_digest=$configuration) GROUP BY state";
        command.Parameters.AddWithValue("$source", (object?)sourceId ?? DBNull.Value); command.Parameters.AddWithValue("$generation", (object?)generation ?? DBNull.Value); command.Parameters.AddWithValue("$configuration", (object?)configuration ?? DBNull.Value); using var reader = command.ExecuteReader(); var result = new Dictionary<string,int>(); while (reader.Read()) result[reader.GetString(0)] = reader.GetInt32(1); return result;
    }
    public int OrphanCount { get { var referenced = Entries().Select(x => x.PayloadPath).ToHashSet(StringComparer.OrdinalIgnoreCase); return Directory.EnumerateFiles(spoolRoot).Count(x => !referenced.Contains(Path.GetFileName(x))); } }
    public QueueEntry? Find(string id) { using var command = db.CreateCommand(); command.CommandText = $"SELECT {Columns} FROM queue WHERE id=$id"; command.Parameters.AddWithValue("$id",id); return ReadEntries(command).FirstOrDefault(); }
    private QueueEntry? FindOriginal(string digest, string configuration) { using var command = db.CreateCommand(); command.CommandText = $"SELECT {Columns} FROM queue WHERE digest=$digest AND config_digest=$configuration"; command.Parameters.AddWithValue("$digest",digest); command.Parameters.AddWithValue("$configuration",configuration); return ReadEntries(command).FirstOrDefault(); }
    public QueuePayload Payload(QueueEntry entry) => Json.Read<QueuePayload>(encryption.Decrypt(File.ReadAllBytes(Path.Combine(spoolRoot, entry.PayloadPath)), entry.Id));
    public QueueEntry Stage(byte[] bytes, string fileName, JsonElementBody body, string generation, string configDigest, bool commitApproved, QueueSourceIdentity? source = null)
    {
        var digest = Convert.ToHexStringLower(SHA256.HashData(bytes)); var existing = FindOriginal(digest,configDigest); if (existing is not null) { RequireSource(existing,source); return existing; }
        var utf8 = new System.Text.UTF8Encoding(false, true); string csv; try { csv = utf8.GetString(bytes); } catch (System.Text.DecoderFallbackException) { throw new ConnectException("CSV_ENCODING_UNSUPPORTED", "Save the source export as UTF-8 CSV."); }
        var payload = new QueuePayload { FileName = fileName, Csv = csv, PreviewBody = body.Build(csv), CommitApproved = commitApproved }; payload.PreviewWireBody = Json.Bytes(payload.PreviewBody); payload.PreviewBodySha256 = Convert.ToHexStringLower(SHA256.HashData(payload.PreviewWireBody)); return StagePayload(bytes, payload, generation, configDigest,source);
    }
    public QueueEntry StageRequest(byte[] bytes, string fileName, JsonElement request, string generation, string configDigest, bool commitApproved, QueueSourceIdentity source,bool history=false)
    {
        var payload = new QueuePayload { FileName=fileName, Csv=new System.Text.UTF8Encoding(false,true).GetString(bytes), PreviewBody=request, PreviewWireBody=Json.Bytes(request), CommitApproved=commitApproved };
        payload.PreviewBodySha256=Convert.ToHexStringLower(SHA256.HashData(payload.PreviewWireBody)); return StagePayload(bytes,payload,generation,configDigest,source,history);
    }
    private static void RequireSource(QueueEntry entry, QueueSourceIdentity? source)
    {
        if(source is not null && (entry.SourceId!=source.SourceId || entry.SourceProfile!=source.SourceProfile || entry.GrantRevision!=source.GrantRevision)) throw new ConnectException("QUEUE_AUTHORITY_CONFLICT","This retained original belongs to another source approval. Preserve it for explicit recovery.");
    }
    public QueueEntry Quarantine(byte[] bytes, string fileName, string generation, string configDigest, string errorCode, QueueSourceIdentity? source = null)
    {
        var entry=StagePayload(bytes,new QueuePayload { FileName=fileName, Csv="", PreviewBody=Json.Element(new {}), CommitApproved=false, QuarantinedOriginalBytes=bytes },generation,configDigest,source);
        if(entry.State=="staged")Save(entry,Payload(entry),"action_needed",error:errorCode);
        return Find(entry.Id)!;
    }
    private QueueEntry StagePayload(byte[] bytes, QueuePayload payload, string generation, string configDigest, QueueSourceIdentity? source,bool history=false)
    {
        var digest=Convert.ToHexStringLower(SHA256.HashData(bytes)); var existing=FindOriginal(digest,configDigest); if(existing is not null){ if(source is not null && (existing.SourceId!=source.SourceId || existing.SourceProfile!=source.SourceProfile || existing.GrantRevision!=source.GrantRevision)) throw new ConnectException("QUEUE_AUTHORITY_CONFLICT","The retained original belongs to a different source approval. Preserve it for review."); if(!history)PromoteLive(existing.Id); return existing; }
        source ??= new(SourceSubscriptionState.LegacyId,SourceSubscriptionState.LegacyProfile,0);
        var id = Guid.NewGuid().ToString("N"); var path = id + ".bin"; var encrypted = encryption.Encrypt(Json.Bytes(payload), id);
        var files = Directory.EnumerateFiles(spoolRoot).Select(x => new FileInfo(x)).ToArray(); var free = new DriveInfo(Path.GetPathRoot(spoolRoot)!).AvailableFreeSpace;
        var references = Entries().ToDictionary(x => x.PayloadPath, StringComparer.OrdinalIgnoreCase);
        // Retained terminal summaries are small protected metadata, not pending
        // originals. Their bytes still count against the complete spool budget.
        // Unknown/orphan files always consume admission capacity until reviewed.
        var originalFiles = files.Count(file => !references.TryGetValue(file.Name, out var reference) || reference.State != "complete" || !Payload(reference).OriginalCompacted);
        var retainedBytes=files.Sum(x=>x.Length);
        // History waits independently before reaching a shared hard limit. Keep
        // both spool and physical-disk headroom available for live originals.
        if(history&&(originalFiles>=Math.Max(1,originalFileLimit-100)||retainedBytes+encrypted.Length>MaxSpoolBytes-256L*1024*1024||free-encrypted.Length<DiskReserveBytes+256L*1024*1024))throw new ConnectException("BACKFILL_LIVE_RESERVE","Historical collection is waiting for capacity reserved for live inputs.");
        if (originalFiles >= originalFileLimit || retainedBytes + encrypted.Length > MaxSpoolBytes || free - encrypted.Length < DiskReserveBytes) throw new ConnectException("SPOOL_CAPACITY_REACHED", "Collection paused to preserve queued originals. Free approved disk space or resolve pending imports.");
        ProtectedStore.AtomicWrite(Path.Combine(spoolRoot, path), encrypted);
        using var tx = db.BeginTransaction(); using var c = db.CreateCommand(); c.Transaction = tx; c.CommandText = "INSERT INTO queue(id,digest,state,preview_key,commit_key,credential_generation,config_digest,next_attempt_at,payload_path,source_id,source_profile,grant_revision) VALUES($id,$digest,'staged',$preview,$commit,$generation,$config,$next,$path,$source,$profile,$grant)";
        c.Parameters.AddWithValue("$id", id); c.Parameters.AddWithValue("$digest", digest); c.Parameters.AddWithValue("$preview", Guid.NewGuid().ToString("N")); c.Parameters.AddWithValue("$commit", Guid.NewGuid().ToString("N")); c.Parameters.AddWithValue("$generation", generation); c.Parameters.AddWithValue("$config", configDigest); c.Parameters.AddWithValue("$next", DateTimeOffset.UtcNow.ToString("O")); c.Parameters.AddWithValue("$path", path); c.Parameters.AddWithValue("$source",source.SourceId); c.Parameters.AddWithValue("$profile",source.SourceProfile); c.Parameters.AddWithValue("$grant",source.GrantRevision); c.ExecuteNonQuery();c.CommandText="INSERT INTO queue_work(queue_id,origin_lane,live_requested,created_at,original_byte_size) VALUES($id,$lane,$live,$created,$bytes)";c.Parameters.AddWithValue("$lane",history?"backfill":"live");c.Parameters.AddWithValue("$live",history?0:1);c.Parameters.AddWithValue("$created",DateTimeOffset.UtcNow.ToString("O"));c.Parameters.AddWithValue("$bytes",bytes.Length);c.ExecuteNonQuery(); tx.Commit(); return Find(id)!;
    }
    public void Save(QueueEntry entry, QueuePayload payload, string state, string? importId = null, string? error = null, bool failed = false, TimeSpan? retryAfter = null)
    {
        if (state == "complete") payload.CompletedAt ??= DateTimeOffset.UtcNow;
        ProtectedStore.AtomicWrite(Path.Combine(spoolRoot, entry.PayloadPath), encryption.Encrypt(Json.Bytes(payload), entry.Id));
        var attempts = failed ? entry.Attempts + 1 : entry.Attempts; var delay = failed ? retryAfter ?? TimeSpan.FromSeconds(Math.Min(300, 2 * Math.Pow(2, Math.Min(attempts, 8))) + Random.Shared.NextDouble() * 2) : TimeSpan.Zero;
        using var tx = db.BeginTransaction(); using var c = db.CreateCommand(); c.Transaction = tx; c.CommandText = "UPDATE queue SET state=$state,import_id=$import,attempts=$attempts,next_attempt_at=$next,error_code=$error WHERE id=$id";
        c.Parameters.AddWithValue("$state", state); c.Parameters.AddWithValue("$import", (object?)importId ?? entry.ImportId ?? (object)DBNull.Value); c.Parameters.AddWithValue("$attempts", attempts); c.Parameters.AddWithValue("$next", DateTimeOffset.UtcNow.Add(delay).ToString("O")); c.Parameters.AddWithValue("$error", (object?)error ?? DBNull.Value); c.Parameters.AddWithValue("$id", entry.Id); c.ExecuteNonQuery(); tx.Commit();
    }
    public int CompactCompleted(DateTimeOffset now)
    {
        var compacted = 0;
        foreach (var entry in Entries().Where(x => x.State == "complete" && x.SourceId == SourceSubscriptionState.LegacyId))
        {
            var payload = Payload(entry);
            if (payload.OriginalCompacted || payload.CompletedAt is null || now - payload.CompletedAt.Value < TimeSpan.FromHours(24) || payload.Receipt is null) continue;
            // The durable source digest and receipt stay available for duplicate
            // detection and support. Only server-confirmed successful originals
            // are eligible; partial, failed and uncertain work is never aged out.
            var receipt = payload.Receipt.Value;
            payload.FileName = ""; payload.Csv = ""; payload.PreviewBody = Json.Element(new { });
            payload.PreviewWireBody = null; payload.CommitWireBody = null;
            payload.Receipt = Json.Element(new { id = receipt.GetProperty("id"), state = receipt.GetProperty("state"), previewVersion = receipt.GetProperty("previewVersion"), original = receipt.GetProperty("original"), counts = receipt.GetProperty("counts"), recordIds = receipt.GetProperty("recordIds"), rows = Array.Empty<object>() });
            payload.OriginalCompacted = true;
            ProtectedStore.AtomicWrite(Path.Combine(spoolRoot, entry.PayloadPath), encryption.Encrypt(Json.Bytes(payload), entry.Id)); compacted++;
        }
        return compacted;
    }
    internal static JsonElement ReceiptWithoutRaw(JsonElement receipt)
    {
        var summary=receipt.EnumerateObject().ToDictionary(p=>p.Name,p=>(object?)p.Value);
        summary["rows"]=receipt.GetProperty("rows").EnumerateArray().Select(r=>r.EnumerateObject().Where(p=>p.Name!="raw").ToDictionary(p=>p.Name,p=>(object?)p.Value)).ToArray();return Json.Element(summary);
    }
    // No general typed-spool aging path exists. Only the current, exact server
    // command may compact one reconciled completed original; queue ownership,
    // digests and durable receipt accounting remain in place.
    internal string CompactApprovedTyped(QueueEntry expected,string commandId,string commandSha256,DateTimeOffset now,string permitId)
    {
        var entry=Find(expected.Id);
        if(entry is null||entry!=expected||entry.State!="complete"||entry.SourceId==SourceSubscriptionState.LegacyId||entry.ImportId is null)throw new ConnectException("SOURCE_COMPACTION_UNSAFE","The exact completed source original must reconcile before compaction.");
        var payload=Payload(entry);var receipt=payload.Receipt;
        if(receipt is null||receipt.Value.GetProperty("id").GetString()!=entry.ImportId||receipt.Value.GetProperty("state").GetString()!="succeeded"||receipt.Value.GetProperty("original").GetProperty("sha256").GetString()!=entry.Digest)throw new ConnectException("SOURCE_COMPACTION_UNSAFE","The retained receipt does not identify this completed original.");
        if(payload.OriginalCompacted)
        {
            if(payload.CompactionCommandId!=commandId||payload.CompactionCommandSha256!=commandSha256||payload.CompactedAt is null||payload.CompactionPermitId!=permitId)throw new ConnectException("SOURCE_COMPACTION_UNSAFE","The retained compaction authorization differs from this command.");
            return "already_compacted";
        }
        AgentRuntime.ValidateTypedAccounting(receipt.Value);
        payload.FileName="";payload.Csv="";payload.QuarantinedOriginalBytes=null;payload.PreviewBody=Json.Element(new{});payload.PreviewWireBody=null;payload.CommitWireBody=null;
        // Drop copies of unmapped raw source fields from receipt rows. Derived
        // assertions and accounting stay available under their separate policy.
        payload.Receipt=ReceiptWithoutRaw(receipt.Value);
        if(string.IsNullOrWhiteSpace(permitId))throw new ConnectException("SOURCE_COMPACTION_UNSAFE","A fresh online compaction permit is required.");
        payload.OriginalCompacted=true;payload.CompactionPermitId=permitId;payload.CompactionCommandId=commandId;payload.CompactionCommandSha256=commandSha256;payload.CompactedAt=now;
        ProtectedStore.AtomicWrite(Path.Combine(spoolRoot,entry.PayloadPath),encryption.Encrypt(Json.Bytes(payload),entry.Id));return "compacted";
    }
    public void Checkpoint() => Execute("PRAGMA wal_checkpoint(FULL)");
    public void Dispose() => db.Dispose();
}
public sealed record JsonElementBody(System.Text.Json.JsonElement Config)
{
    public System.Text.Json.JsonElement Build(string csv) => Json.Element(new { integrationAccountId = Config.GetProperty("integrationAccountId").GetString(), operatorMembershipId = Config.GetProperty("operatorMembershipId").GetString(), sourceName = Config.GetProperty("sourceName").GetString(), mapping = Config.GetProperty("mapping"), timeZone = Config.GetProperty("timeZone").GetString(), csv });
}
