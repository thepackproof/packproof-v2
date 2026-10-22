import { randomBytes } from 'node:crypto';
import { createPgliteDatabase } from '../src/db/pglite.js';
import { createPgDatabase } from '../src/db/postgres.js';
import { migrate } from '../src/db/migrate.js';

/** A fresh public-schema database and separate restore authority. PostgreSQL
 * lifecycle operations accept only an explicitly configured loopback test host.
 * Never consult application credentials or an existing target database. */
export async function openFreshRestoreTestDatabase() {
  const connection = process.env.PACKPROOF_TEST_DATABASE_URL;
  const suffix = randomBytes(8).toString('hex');
  const restoreRole = `packproof_restore_claims_${suffix}`;
  if (!connection) {
    const opened = await createPgliteDatabase();
    try {
      await migrate(opened.db);
      await opened.db.query(`CREATE ROLE ${restoreRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await grantRestore(opened.db, restoreRole);
      await opened.db.query(`SET ROLE ${restoreRole}`);
      const database = (await opened.db.query<{name:string}>('SELECT current_database() AS name')).rows[0].name;
      return { ...opened, restoreRole, database, engine: 'pglite' as const };
    } catch (error) { await opened.close(); throw error; }
  }
  const url = new URL(connection);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Fresh restore test database requires a loopback PostgreSQL host');
  }
  const database = `packproof_restore_test_${suffix}`;
  const admin = createPgDatabase(connection);
  let owner: ReturnType<typeof createPgDatabase> | undefined;
  let runtime: ReturnType<typeof createPgDatabase> | undefined;
  let databaseCreated = false, roleCreated = false;
  const close = async () => {
    try {
      await runtime?.close(); runtime = undefined;
      await owner?.close(); owner = undefined;
      if (databaseCreated) { await admin.db.query(`DROP DATABASE ${database}`); databaseCreated = false; }
      if (roleCreated) { await admin.db.query(`DROP ROLE ${restoreRole}`); roleCreated = false; }
    } finally { await admin.close(); }
  };
  try {
    await admin.db.query(`CREATE DATABASE ${database}`);
    databaseCreated = true;
    await admin.db.query(`REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC`);
    url.pathname = '/' + database;
    url.searchParams.delete('options');
    owner = createPgDatabase(url.toString());
    await migrate(owner.db);
    const password = randomBytes(32).toString('hex');
    await admin.db.query(`CREATE ROLE ${restoreRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    roleCreated = true;
    await admin.db.query(`GRANT CONNECT ON DATABASE ${database} TO ${restoreRole}`);
    await grantRestore(owner.db, restoreRole);
    await owner.close(); owner = undefined;
    url.username = restoreRole; url.password = password;
    runtime = createPgDatabase(url.toString());
    return { db: runtime.db, close, restoreRole, database, engine: 'postgresql' as const };
  } catch (error) {
    await close();
    throw error;
  }
}

async function grantRestore(db: ReturnType<typeof createPgDatabase>['db'], role:string) {
  await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await db.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await db.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await db.query(`GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
}
