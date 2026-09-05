import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { createPgliteDatabase } from "../src/db/pglite.js";
import { createPgDatabase } from "../src/db/postgres.js";
import type { Database } from "../src/db/database.js";

async function checkConcurrentMigrations(first: Database, second: Database) {
  await Promise.all([migrate(first), migrate(second)]);
  const expected = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((file) => file.endsWith(".sql")).length;
  const applied = await first.query<{ id: string }>("SELECT id FROM schema_migrations");
  expect(applied.rows).toHaveLength(expected);
  expect(new Set(applied.rows.map((row) => row.id)).size).toBe(expected);
  await first.query(
    "INSERT INTO users (id, created_at, updated_at) VALUES ($1, NOW(), NOW())",
    ["migration-preserved-user"],
  );
  await Promise.all([migrate(first), migrate(second)]);
  expect((await second.query("SELECT id FROM users WHERE id = $1", ["migration-preserved-user"])).rows)
    .toEqual([{ id: "migration-preserved-user" }]);
}

describe("concurrent application startup migrations", () => {
  it("rolls back a failed migration and permits a corrected retry", async () => {
    const opened = await createPgliteDatabase();
    const directory = await mkdtemp(path.join(tmpdir(), "packproof-migration-"));
    const file = path.join(directory, "001_atomic.sql");
    try {
      await writeFile(file, "CREATE TABLE atomic_example (id TEXT); INSERT INTO missing_table VALUES ('failure');");
      await expect(migrate(opened.db, directory)).rejects.toThrow();
      expect((await opened.db.query("SELECT to_regclass('atomic_example') AS name")).rows)
        .toEqual([{ name: null }]);
      expect((await opened.db.query("SELECT * FROM schema_migrations")).rows).toHaveLength(0);
      await writeFile(file, "CREATE TABLE atomic_example (id TEXT); INSERT INTO atomic_example VALUES ('ready');");
      await migrate(opened.db, directory);
      await migrate(opened.db, directory);
      expect((await opened.db.query("SELECT * FROM atomic_example")).rows).toEqual([{ id: "ready" }]);
      expect((await opened.db.query("SELECT * FROM schema_migrations")).rows).toHaveLength(1);
    } finally {
      await opened.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("applies the schema once and preserves existing records on retry", async () => {
    const opened = await createPgliteDatabase();
    try {
      await checkConcurrentMigrations(opened.db, opened.db);
    } finally {
      await opened.close();
    }
  });

  // CI provides a disposable PostgreSQL service. A uniquely named schema keeps
  // this test isolated; neither public nor another test's schema is modified.
  it.skipIf(!process.env.PACKPROOF_MIGRATION_TEST_DATABASE_URL)(
    "serializes independent PostgreSQL connection pools during a rolling startup",
    async () => {
      const url = new URL(process.env.PACKPROOF_MIGRATION_TEST_DATABASE_URL!);
      const schema = `migration_test_${randomBytes(10).toString("hex")}`;
      const admin = new pg.Client({ connectionString: url.toString() });
      await admin.connect();
      let first: ReturnType<typeof createPgDatabase> | undefined;
      let second: ReturnType<typeof createPgDatabase> | undefined;
      try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        url.searchParams.set("options", `-c search_path=${schema}`);
        first = createPgDatabase(url.toString());
        second = createPgDatabase(url.toString());
        await checkConcurrentMigrations(first.db, second.db);
      } finally {
        await Promise.all([first?.close(), second?.close()]);
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    },
  );
});
