import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./database.js";
import { splitSqlStatements } from "./sql.js";

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

export async function migrate(db: Database, directory = migrationsDir): Promise<void> {
  await db.transaction(async (tx) => {
    // Even CREATE TABLE IF NOT EXISTS can race against another fresh startup
    // in PostgreSQL's system catalog. Serialize the bootstrap before table locks exist.
    await tx.query(`SELECT pg_advisory_xact_lock(1347440454)`);
    await tx.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL
      )
    `);
  });

  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const id = file.replace(/\.sql$/i, "");
    const sql = await readFile(path.join(directory, file), "utf8");
    await db.transaction(async (tx) => {
      // Rolling deployments can start multiple instances. Recheck under the
      // database lock and commit the schema change with its migration record.
      await tx.query(`LOCK TABLE schema_migrations IN EXCLUSIVE MODE`);
      const applied = await tx.query<{ id: string }>(
        `SELECT id FROM schema_migrations WHERE id = $1`,
        [id],
      );
      if (applied.rows.length > 0) return;
      for (const statement of splitSqlStatements(sql)) {
        if (/CREATE TABLE schema_migrations/i.test(statement)) continue;
        await tx.query(statement);
      }
      await tx.query(
        `INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)`,
        [id, new Date().toISOString()],
      );
    });
  }
}
