import pg from "pg";
import type { Database, QueryResult } from "./database.js";
import { databaseUnavailable } from "./rotating-credentials.js";

function toResult<Row>(result: pg.QueryResult): QueryResult<Row> {
  return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
}

function sslConfigFromConnectionString(connectionString: string): pg.PoolConfig["ssl"] {
  try {
    const sslmode = new URL(connectionString).searchParams.get("sslmode")?.toLowerCase();
    if (!sslmode || sslmode === "disable") return undefined;
    if (sslmode === "verify-ca" || sslmode === "verify-full") return { rejectUnauthorized: true };
    return { rejectUnauthorized: false };
  } catch { return undefined; }
}

export function postgresPoolConfig(
  connectionString: string,
  passwordProvider?: () => Promise<string>,
): pg.PoolConfig {
  const ssl = sslConfigFromConnectionString(connectionString);
  if (passwordProvider) {
    const url = new URL(connectionString);
    // A connection-string password overrides pg's callback. Pass the connection
    // coordinates separately so a stale injected password can never win.
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      database: decodeURIComponent(url.pathname.slice(1)),
      user: decodeURIComponent(url.username),
      password: passwordProvider,
      ssl,
      application_name: url.searchParams.get("application_name") ?? undefined,
      options: url.searchParams.get("options") ?? undefined,
      connectionTimeoutMillis: 10_000,
    };
  }
  let poolConnectionString = connectionString;
  try {
    const url = new URL(connectionString);
    url.searchParams.delete("sslmode");
    url.searchParams.delete("uselibpqcompat");
    poolConnectionString = url.toString();
  } catch { /* pg retains responsibility for validating non-URL connection strings. */ }
  return { connectionString: poolConnectionString, ssl };
}

function mapDatabaseError(error: unknown): unknown {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (["28P01", "28000", "53300", "57P01", "57P02", "57P03", "ECONNREFUSED", "ETIMEDOUT"].includes(String(code))) {
    return databaseUnavailable();
  }
  return error;
}

export function createPgDatabase(connectionString: string, passwordProvider?: () => Promise<string>): {
  db: Database;
  close: () => Promise<void>;
} {
  const pool = new pg.Pool(postgresPoolConfig(connectionString, passwordProvider));
  pool.on("error", () => {
    // pg removes broken idle connections; logging an error object could expose
    // connection details. Subsequent connections resolve the current secret.
    console.error(JSON.stringify({ event: "database_idle_connection_error" }));
  });
  const db: Database = {
    query: async <Row>(sql: string, params: unknown[] = []) => {
      try { return toResult<Row>(await pool.query(sql, params)); }
      catch (error) { throw mapDatabaseError(error); }
    },
    transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => {
      const connection = await pool.connect().catch((error) => { throw mapDatabaseError(error); });
      let discardConnection = false;
      const tx: Database = {
        query: async <Row>(sql: string, params: unknown[] = []) => toResult<Row>(await connection.query(sql, params)),
        transaction: async <U>(inner: (nested: Database) => Promise<U>) => inner(tx),
      };
      try {
        await connection.query("BEGIN");
        const value = await fn(tx);
        await connection.query("COMMIT");
        return value;
      } catch (error) {
        try { await connection.query("ROLLBACK"); }
        catch { discardConnection = true; }
        throw mapDatabaseError(error);
      } finally { connection.release(discardConnection); }
    },
  };
  return { db, close: async () => { await pool.end(); } };
}
