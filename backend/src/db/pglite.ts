import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Database, QueryResult } from "./database.js";

class PgliteDatabase implements Database {
  constructor(private readonly client: PGlite) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.client.query<T>(sql, params);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  }

  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return this.client.transaction(async (tx) => {
      const wrapped: Database = {
        query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
          const result = await tx.query<R>(sql, params);
          return {
            rows: result.rows,
            rowCount: result.affectedRows ?? result.rows.length,
          };
        },
        transaction: async (inner) => inner(wrapped),
      };
      return fn(wrapped);
    });
  }
}

export async function createPgliteDatabase(dataDir?: string): Promise<{
  db: Database;
  close: () => Promise<void>;
}> {
  let pglite: PGlite;
  if (dataDir) {
    await mkdir(dataDir, { recursive: true });
    pglite = new PGlite(path.join(dataDir, "packproof"));
  } else {
    pglite = new PGlite();
  }
  await pglite.waitReady;
  return {
    db: new PgliteDatabase(pglite),
    close: async () => {
      await pglite.close();
    },
  };
}
