import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./database.js";
import { splitSqlStatements } from "./sql.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

export async function migrate(db: Database, sourceDir = migrationsDir): Promise<void> {
  // Every replica starts migrations before listening. The same transaction-scoped
  // lock protects both first-time bootstrap and the check/apply pair; a check
  // outside this lock lets two rolling-deploy tasks apply the same DDL.
  const lock = (tx: Database) => tx.query(`SELECT pg_advisory_xact_lock(1347438146, 1)`);
  await db.transaction(async (tx) => {
    await lock(tx);
    await tx.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL
    )
  `);
  });

  const files = (await readdir(sourceDir)).filter((name) => name.endsWith(".sql")).sort();

  for (const file of files) {
    const id = file.replace(/\.sql$/i, "");
    const sql = await readFile(path.join(sourceDir, file), "utf8");
    await db.transaction(async (tx) => {
      await lock(tx);
      const applied = await tx.query<{ id: string }>(
        `SELECT id FROM schema_migrations WHERE id = $1`,
        [id],
      );
      if (applied.rows.length > 0) return;
      for (const statement of splitSqlStatements(sql)) {
        if (/CREATE TABLE schema_migrations/i.test(statement)) {
          continue;
        }
        await tx.query(statement);
      }
      await tx.query(`INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)`, [
        id,
        new Date().toISOString(),
      ]);
    });
  }
}
