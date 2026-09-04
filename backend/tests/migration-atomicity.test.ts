import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { createPgliteDatabase } from "../src/db/pglite.js";

describe("atomic migrations", () => {
  let opened: Awaited<ReturnType<typeof createPgliteDatabase>>;
  let directory: string;
  afterEach(async () => { await opened?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

  it("rolls back partial schema changes and successfully retries a corrected migration", async () => {
    opened = await createPgliteDatabase();
    directory = await mkdtemp(path.join(os.tmpdir(), "packproof-migration-"));
    const file = path.join(directory, "001_atomic.sql");
    await writeFile(file, "CREATE TABLE atomic_example (id TEXT); INSERT INTO missing_table VALUES ('failure');");
    await expect(migrate(opened.db, directory)).rejects.toThrow();
    expect((await opened.db.query(`SELECT to_regclass('atomic_example') AS name`)).rows[0]).toEqual({ name: null });
    expect((await opened.db.query(`SELECT * FROM schema_migrations`)).rows).toHaveLength(0);
    await writeFile(file, "CREATE TABLE atomic_example (id TEXT); INSERT INTO atomic_example VALUES ('ready');");
    await migrate(opened.db, directory);
    await migrate(opened.db, directory);
    expect((await opened.db.query(`SELECT * FROM atomic_example`)).rows).toEqual([{ id: "ready" }]);
    expect((await opened.db.query(`SELECT * FROM schema_migrations`)).rows).toHaveLength(1);
  });

  it("applies each migration once when two startup runners overlap", async () => {
    opened = await createPgliteDatabase();
    directory = await mkdtemp(path.join(os.tmpdir(), "packproof-migration-"));
    await writeFile(path.join(directory, "001_once.sql"), "CREATE TABLE migration_once (id TEXT); INSERT INTO migration_once VALUES ('once');");
    await Promise.all([migrate(opened.db, directory), migrate(opened.db, directory)]);
    expect((await opened.db.query(`SELECT * FROM migration_once`)).rows).toEqual([{ id: "once" }]);
    expect((await opened.db.query(`SELECT * FROM schema_migrations`)).rows).toHaveLength(1);
  });
});
