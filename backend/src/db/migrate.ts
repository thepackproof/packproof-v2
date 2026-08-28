import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./database.js";
import { splitSqlStatements } from "./sql.js";

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

export async function migrate(db: Database): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL
    )
  `);
  const applied = await db.query<{ id: string }>(
    `SELECT id FROM schema_migrations WHERE id = $1`,
    ["001_init"],
  );
  if (applied.rows.length > 0) {
    return;
  }

  const sql = await readFile(path.join(migrationsDir, "001_init.sql"), "utf8");
  for (const statement of splitSqlStatements(sql)) {
    if (/CREATE TABLE schema_migrations/i.test(statement)) {
      continue;
    }
    await db.query(statement);
  }
  await db.query(
    `INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)`,
    ["001_init", new Date().toISOString()],
  );
}
