import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertSchemaCurrent, migrate, migrationInventory } from '../src/db/migrate.js';
import { createPgliteDatabase } from '../src/db/pglite.js';

// Deliberately independent release pins: an accidental bridge allowlist change
// must not silently redefine the accepted migration contract in its own tests.
const futureMigrations = [
  ['069_system_admin', '95f2eb6a14f703fc1a7d6a69c4c651147c1590424a3978c8256e95bbc9f32cd3'],
  ['070_public_analytics', '56f2d727ae90a9b19163f43e5b43c1f1973deb0fd0ec96262273dd9094a4c5d8'],
  ['071_admin_error_triage', '57f74e7ade72ed5f57239d93ae06f6c0b3e1c33984ee8334843f9e558d96a247'],
  ['072_admin_read_indexes', '43052f95d34060f14bdfd67b9756c6542d3279ac4a5a21f8480b3bd1ed5e01f1'],
  ['073_client_version_activity', '6a1815b36939790632a73e8650e49b2fc9733e798fc75a620406f751bf75573a'],
] as const;

describe('admin release rollback schema bridge', () => {
  let opened: Awaited<ReturnType<typeof createPgliteDatabase>>;
  let baseline: Awaited<ReturnType<typeof migrationInventory>>;

  beforeAll(async () => {
    opened = await createPgliteDatabase();
    baseline = await migrationInventory();
    await migrate(opened.db);
    await opened.db.query("INSERT INTO users (id, created_at, updated_at) VALUES ('bridge-existing-user', NOW(), NOW())");
  });

  beforeEach(async () => {
    await opened.db.query('DELETE FROM schema_migrations');
    for (const item of baseline) await record(item.id, item.checksum);
  });

  afterAll(async () => { await opened?.close(); });

  async function record(id: string, checksum: string | null) {
    await opened.db.query(
      "INSERT INTO schema_migrations (id, checksum, applied_at, checksum_provenance) VALUES ($1, $2, NOW(), 'EXECUTED_BYTES')",
      [id, checksum],
    );
  }

  it('starts on the complete original schema without requiring future tables', async () => {
    expect(baseline.at(-1)?.id).toBe('068_commerce_sync_checkpoints');
    await expect(assertSchemaCurrent(opened.db)).resolves.toBeUndefined();
    expect((await opened.db.query("SELECT to_regclass('user_system_roles') AS table_name")).rows)
      .toEqual([{ table_name: null }]);
  });

  it('accepts every partial prefix and the complete pinned future ledger without mutating it', async () => {
    for (const [id, checksum] of futureMigrations) {
      await record(id, checksum);
      await expect(assertSchemaCurrent(opened.db)).resolves.toBeUndefined();
    }
    await migrate(opened.db);
    expect((await opened.db.query('SELECT id, checksum FROM schema_migrations ORDER BY id')).rows)
      .toEqual([...baseline.map(({ id, checksum }) => ({ id, checksum })),
        ...futureMigrations.map(([id, checksum]) => ({ id, checksum }))]);
    expect((await opened.db.query("SELECT id FROM users WHERE id='bridge-existing-user'")).rows)
      .toEqual([{ id: 'bridge-existing-user' }]);
  });

  it.each(futureMigrations)('rejects altered future bytes for %s', async (id) => {
    await record(id, '0'.repeat(64));
    await expect(assertSchemaCurrent(opened.db)).rejects.toThrow('outside this release compatibility envelope');
  });

  it('rejects an unverified future checksum', async () => {
    await record(futureMigrations[0][0], null);
    await expect(assertSchemaCurrent(opened.db)).rejects.toThrow('outside this release compatibility envelope');
  });

  it('rejects unknown future IDs even when their checksum matches a permitted migration', async () => {
    await record('074_unreviewed_change', futureMigrations[0][1]);
    await expect(assertSchemaCurrent(opened.db)).rejects.toThrow('outside this release compatibility envelope');
  });

  it('still rejects a missing baseline migration after all future migrations', async () => {
    for (const [id, checksum] of futureMigrations) await record(id, checksum);
    await opened.db.query('DELETE FROM schema_migrations WHERE id=$1', [baseline[0].id]);
    await expect(assertSchemaCurrent(opened.db)).rejects.toThrow(`Migration required or checksum mismatch: ${baseline[0].id}`);
  });

  it('still rejects an altered baseline migration after all future migrations', async () => {
    for (const [id, checksum] of futureMigrations) await record(id, checksum);
    await opened.db.query('UPDATE schema_migrations SET checksum=$2 WHERE id=$1', [baseline[0].id, '0'.repeat(64)]);
    await expect(assertSchemaCurrent(opened.db)).rejects.toThrow(`Migration required or checksum mismatch: ${baseline[0].id}`);
  });
});
