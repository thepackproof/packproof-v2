import pg from "pg";
import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import type { Database, QueryResult } from "./database.js";
import { databaseUnavailable } from "./rotating-credentials.js";

function toResult<Row>(result: pg.QueryResult): QueryResult<Row> {
  return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
}

export function sslConfigFromConnectionString(connectionString:string,env:NodeJS.ProcessEnv=process.env):ConnectionOptions|undefined {
  const url=new URL(connectionString);
  const mode=url.searchParams.get('sslmode')?.toLowerCase();
  const hosted=['production','staging'].includes(env.PACKPROOF_ENVIRONMENT??'');
  if(mode==='disable'&&hosted)throw new Error('Hosted PostgreSQL requires verified TLS');
  if((!mode&&!hosted)||mode==='disable')return undefined;
  if(mode&&!['require','verify-ca','verify-full'].includes(mode))throw new Error('PostgreSQL TLS mode must require certificate verification');
  const caFile=env.PACKPROOF_DB_CA_FILE?.trim()||url.searchParams.get('sslrootcert');
  let ca:string|undefined;
  if(caFile){try{ca=readFileSync(caFile,'utf8');}catch{throw new Error('Configured PostgreSQL CA bundle is unavailable');}}
  else if(env.PACKPROOF_DB_CA_PEM)ca=env.PACKPROOF_DB_CA_PEM;
  if(ca&&(!ca.includes('-----BEGIN CERTIFICATE-----')||ca.includes('PRIVATE KEY')))throw new Error('PostgreSQL CA bundle must contain public certificates');
  // Keep Node's hostname check enabled for require, verify-ca and verify-full alike.
  return {rejectUnauthorized:true,...(ca?{ca}:{}),minVersion:'TLSv1.2'};
}

export function postgresPoolConfig(
  connectionString: string,
  passwordProvider?: () => Promise<string>,
  env:NodeJS.ProcessEnv=process.env,
): pg.PoolConfig {
  const ssl = sslConfigFromConnectionString(connectionString,env);
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
      statement_timeout:30000, query_timeout:35000,
    };
  }
  let poolConnectionString = connectionString;
  try {
    const url = new URL(connectionString);
    for(const key of ["sslmode","sslrootcert","sslcert","sslkey","ssl"])url.searchParams.delete(key);
    url.searchParams.delete("uselibpqcompat");
    poolConnectionString = url.toString();
  } catch { /* pg retains responsibility for validating non-URL connection strings. */ }
  return { connectionString: poolConnectionString, ssl, connectionTimeoutMillis:10000, statement_timeout:30000, query_timeout:35000 };
}

function mapDatabaseError(error: unknown): unknown {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (["28P01", "28000", "53300", "57P01", "57P02", "57P03", "ECONNREFUSED", "ETIMEDOUT"].includes(String(code))) {
    return databaseUnavailable();
  }
  return error;
}

export function createPgDatabase(connectionString: string, passwordProvider?: () => Promise<string>,env:NodeJS.ProcessEnv=process.env): {
  db: Database;
  close: () => Promise<void>;
} {
  const pool = new pg.Pool(postgresPoolConfig(connectionString, passwordProvider,env));
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
