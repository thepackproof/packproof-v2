import pg from "pg";
import type { Database, QueryResult } from "./database.js";

function toResult<T>(result: pg.QueryResult): QueryResult<T> {
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}

export function createPgDatabase(connectionString: string): {
  db: Database;
  close: () => Promise<void>;
} {
  const pool = new pg.Pool({ connectionString });

  const db: Database = {
    query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      return toResult<T>(await pool.query(sql, params));
    },
    transaction: async <T>(fn: (tx: Database) => Promise<T>) => {
      const conn = await pool.connect();
      const tx: Database = {
        query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
          return toResult<R>(await conn.query(sql, params));
        },
        transaction: async (inner) => inner(tx),
      };
      try {
        await conn.query("BEGIN");
        const value = await fn(tx);
        await conn.query("COMMIT");
        return value;
      } catch (error) {
        await conn.query("ROLLBACK");
        throw error;
      } finally {
        conn.release();
      }
    },
  };

  return {
    db,
    close: async () => {
      await pool.end();
    },
  };
}
