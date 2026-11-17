using Microsoft.Data.Sqlite;
using System.Text.RegularExpressions;
namespace PackProof.Connect;

// Version 0.2.0 added source partition columns to the existing queue. The
// ordinary shipment lane is compatible only after its exact layout and every
// retained row are verified. Typed-source and later permit/backfill formats
// must remain with their source-aware collector; a larger app version is not
// evidence that an older queue reader understands those permissions.
internal static class QueueSchemaCompatibility
{
    private static ConnectException Unsupported() => new("QUEUE_SCHEMA_UNSUPPORTED", "This retained queue needs a source-compatible PackProof helper. Its version, original files, receipt identities and encryption key were preserved.");
    private static ConnectException SourceRequired() => new("QUEUE_SOURCE_RUNTIME_REQUIRED", "This queue contains source-specific work. Install the source-aware PackProof collector to continue it; source identities, approvals, originals and keys were preserved.");
    internal static int Inspect(SqliteConnection db, bool sourceAware)
    {
        using var command = db.CreateCommand();
        command.CommandText = "PRAGMA user_version"; var version = Convert.ToInt32(command.ExecuteScalar());
        if (version < 0 || version > (sourceAware ? 4 : 2)) throw Unsupported();
        command.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='meta'";
        var hasMeta = Convert.ToInt32(command.ExecuteScalar()) == 1;
        int? metadata = null;
        if (hasMeta)
        {
            RequireColumns(db, "meta", [new("version", "INTEGER", true, null, 0)]);
            command.CommandText = "SELECT version FROM meta";
            using var reader = command.ExecuteReader();
            if (!reader.Read() || reader.GetFieldType(0) != typeof(long)) throw Unsupported();
            metadata = reader.GetInt32(0); if (reader.Read()) throw Unsupported();
        }
        if (version >= 2 || metadata >= 2)
        {
            if (version != metadata) throw Unsupported();
            RequireLayout(db, version, sourceAware);
            return version;
        }
        if (metadata is not null and not 1 || version == 1 && metadata is null) throw Unsupported();
        if (metadata == 1) RequireLayout(db, 1, sourceAware);
        else
        {
            command.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'";
            if (Convert.ToInt64(command.ExecuteScalar()) != 0) throw Unsupported();
        }
        return version;
    }
    private static void RequireLayout(SqliteConnection db, int version, bool sourceAware)
    {
        var partitioned = version >= 2;
        // Reject unrecognized structures rather than treating a version marker
        // alone as permission to reinterpret retained work.
        using var command = db.CreateCommand();
        command.CommandText = "SELECT name FROM sqlite_master WHERE (type='table' AND name NOT LIKE 'sqlite_%') OR type IN ('trigger','view') ORDER BY name";
        var objects = new List<string>(); using (var reader = command.ExecuteReader()) while (reader.Read()) objects.Add(reader.GetString(0));
        string[] expectedObjects = version < 4 ? ["meta", "queue"] : ["meta", "queue", "queue_backfill_items", "queue_work"];
        if (!objects.SequenceEqual(expectedObjects)) throw Unsupported();
        if (version == 4)
        {
            RequireSql(db, "queue_work", "CREATE TABLE queue_work(queue_id TEXT PRIMARY KEY REFERENCES queue(id),origin_lane TEXT NOT NULL CHECK(origin_lane IN ('live','backfill')),live_requested INTEGER NOT NULL,created_at TEXT,original_byte_size INTEGER)");
            RequireSql(db, "queue_backfill_items", "CREATE TABLE queue_backfill_items(job_id TEXT NOT NULL,item_id TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,queue_id TEXT REFERENCES queue(id),error_code TEXT,PRIMARY KEY(job_id,item_id))");
            command.CommandText = "SELECT EXISTS(SELECT 1 FROM queue LEFT JOIN queue_work w ON w.queue_id=queue.id WHERE w.queue_id IS NULL) OR EXISTS(SELECT 1 FROM queue_work WHERE live_requested NOT IN (0,1) OR (origin_lane='live' AND live_requested!=1))";
            if (Convert.ToInt64(command.ExecuteScalar()) != 0) throw Unsupported();
            command.CommandText = "PRAGMA foreign_key_check";
            using var rows = command.ExecuteReader();
            if (rows.Read()) throw Unsupported();
        }
        RequireColumns(db, "meta", [new("version", "INTEGER", true, null, 0)]);
        Column[] columns = [new("id", "TEXT", false, null, 1), new("digest", "TEXT", true, null, 0), new("state", "TEXT", true, null, 0), new("preview_key", "TEXT", true, null, 0), new("commit_key", "TEXT", true, null, 0), new("credential_generation", "TEXT", true, null, 0), new("config_digest", "TEXT", true, null, 0), new("import_id", "TEXT", false, null, 0), new("attempts", "INTEGER", true, "0", 0), new("next_attempt_at", "TEXT", true, null, 0), new("error_code", "TEXT", false, null, 0), new("payload_path", "TEXT", true, null, 0)];
        if (partitioned) columns = [.. columns, new("source_id", "TEXT", true, "'legacy'", 0), new("source_profile", "TEXT", true, "'shipment-csv/v1'", 0), new("grant_revision", "INTEGER", true, "0", 0)];
        RequireColumns(db, "queue", columns);
        command.CommandText = "PRAGMA index_list(queue)";
        var indexes = new Dictionary<string, bool>();
        using (var reader = command.ExecuteReader()) while (reader.Read()) { if (reader.GetInt32(4) != 0) throw Unsupported(); indexes.Add(reader.GetString(1), reader.GetInt32(2) == 1); }
        var expected = new Dictionary<string, (bool Unique, string[] Columns)>
        {
            ["sqlite_autoindex_queue_1"] = (true, ["id"]),
            ["sqlite_autoindex_queue_2"] = (true, ["digest", "config_digest"])
        };
        if (partitioned)
        {
            expected["queue_source_due"] = (false, ["source_id", "credential_generation", "config_digest", "state", "next_attempt_at"]);
            expected["queue_source_page"] = (false, ["source_id", "id"]);
        }
        if (indexes.Count != expected.Count || indexes.Any(pair => !expected.TryGetValue(pair.Key, out var definition) || definition.Unique != pair.Value)) throw Unsupported();
        RequireSql(db, "meta", "CREATE TABLE meta(version INTEGER NOT NULL)");
        var baseSql = "CREATE TABLE queue(id TEXT PRIMARY KEY,digest TEXT NOT NULL,state TEXT NOT NULL,preview_key TEXT NOT NULL,commit_key TEXT NOT NULL,credential_generation TEXT NOT NULL,config_digest TEXT NOT NULL,import_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL,error_code TEXT,payload_path TEXT NOT NULL,";
        RequireSql(db, "queue", baseSql + (partitioned ? "source_id TEXT NOT NULL DEFAULT 'legacy',source_profile TEXT NOT NULL DEFAULT 'shipment-csv/v1',grant_revision INTEGER NOT NULL DEFAULT 0," : "") + "UNIQUE(digest,config_digest))");
        foreach (var pair in expected)
        {
            if (!pair.Key.StartsWith("sqlite_", StringComparison.Ordinal)) RequireSql(db, pair.Key, "CREATE INDEX " + pair.Key + " ON queue(" + string.Join(",", pair.Value.Columns) + ")");
            command.CommandText = "PRAGMA index_info(\"" + pair.Key + "\")";
            var indexedColumns = new List<string>(); using (var reader = command.ExecuteReader()) while (reader.Read()) indexedColumns.Add(reader.GetString(2));
            if (!indexedColumns.SequenceEqual(pair.Value.Columns)) throw Unsupported();
        }
        command.CommandText = "SELECT count(*) FROM sqlite_master WHERE type='index' AND sql IS NOT NULL";
        if (Convert.ToInt32(command.ExecuteScalar()) != (partitioned ? 2 : 0)) throw Unsupported();
        if (partitioned)
        {
            command.CommandText = sourceAware
                ? "SELECT COUNT(*) FROM queue WHERE source_id='' OR source_profile='' OR (source_id='legacy' AND (source_profile!='shipment-csv/v1' OR grant_revision!=0)) OR (source_id!='legacy' AND (source_profile='shipment-csv/v1' OR grant_revision<=0))"
                : "SELECT COUNT(*) FROM queue WHERE source_id!='legacy' OR source_profile!='shipment-csv/v1' OR grant_revision!=0";
            if (Convert.ToInt64(command.ExecuteScalar()) != 0) throw SourceRequired();
        }
    }
    private static void RequireSql(SqliteConnection db, string name, string expected)
    {
        using var command = db.CreateCommand(); command.CommandText = "SELECT sql FROM sqlite_master WHERE name=$name"; command.Parameters.AddWithValue("$name", name);
        var sql = command.ExecuteScalar() as string;
        static string Canonical(string value) => Regex.Replace(value, @"\s+", "").Replace("IFNOTEXISTS", "", StringComparison.OrdinalIgnoreCase).ToUpperInvariant();
        if (sql is null || Canonical(sql) != Canonical(expected)) throw Unsupported();
    }
    private sealed record Column(string Name, string Type, bool Required, string? Default, int PrimaryKey);
    private static void RequireColumns(SqliteConnection db, string table, Column[] expected)
    {
        using var command = db.CreateCommand(); command.CommandText = "PRAGMA table_info(" + table + ")";
        var columns = new List<Column>();
        using (var reader = command.ExecuteReader()) while (reader.Read()) columns.Add(new(reader.GetString(1), reader.GetString(2).ToUpperInvariant(), reader.GetInt32(3) == 1, reader.IsDBNull(4) ? null : reader.GetString(4), reader.GetInt32(5)));
        if (!columns.SequenceEqual(expected)) throw Unsupported();
    }
}
