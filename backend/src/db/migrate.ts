import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./database.js";
import { splitSqlStatements } from "./sql.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

export async function migrate(db: Database): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL
    )
  `);

  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();

  for (const file of files) {
    const id = file.replace(/\.sql$/i, "");
    const applied = await db.query<{ id: string }>(
      `SELECT id FROM schema_migrations WHERE id = $1`,
      [id],
    );
    if (applied.rows.length > 0) {
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await db.transaction(async (tx) => {
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
