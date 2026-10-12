import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertSchemaCurrent, migrate, migrationInventory } from "../src/db/migrate.js";
import { FORWARD_COMPATIBLE_MIGRATIONS } from "../src/db/forward-compatible-migrations.js";
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
  it("remains ready across only exact reviewed additive receipts", async () => {
    const opened = await createPgliteDatabase();
    try {
      await migrate(opened.db);
      const inventory = await migrationInventory();
      for (const future of FORWARD_COMPATIBLE_MIGRATIONS) {
      const sourceEntry = inventory.find(row => row.id === future.id);
      if (sourceEntry) expect(sourceEntry.checksum).toBe(future.checksum);
      await expect(assertSchemaCurrent(opened.db)).resolves.toBeUndefined();
      if (!sourceEntry) await opened.db.query(
        "INSERT INTO schema_migrations(id,applied_at,checksum,checksum_provenance) VALUES($1,NOW(),$2,'EXECUTED_BYTES')",
        [future.id, future.checksum],
      );
      await expect(assertSchemaCurrent(opened.db)).resolves.toBeUndefined();
      await expect(assertSchemaCurrent(opened.db, undefined, true)).resolves.toBeUndefined();

      await opened.db.query("UPDATE schema_migrations SET checksum=$2 WHERE id=$1", [future.id, '0'.repeat(64)]);
      await expect(assertSchemaCurrent(opened.db)).rejects.toThrow();
      await opened.db.query("UPDATE schema_migrations SET checksum=$2 WHERE id=$1", [future.id, future.checksum]);
      }
      await opened.db.query("INSERT INTO schema_migrations(id,applied_at,checksum) VALUES('077_unreviewed',NOW(),$1)", ['a'.repeat(64)]);
      await expect(assertSchemaCurrent(opened.db)).rejects.toThrow('outside this release compatibility envelope');
      await opened.db.query("DELETE FROM schema_migrations WHERE id='077_unreviewed'");

      const required = inventory[0]!;
      await opened.db.query("DELETE FROM schema_migrations WHERE id=$1", [required.id]);
      await expect(assertSchemaCurrent(opened.db)).rejects.toThrow(`Migration required or checksum mismatch: ${required.id}`);
    } finally {
      await opened.close();
    }
  });

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
