import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createPgDatabase } from '../src/db/postgres.ts';
import { migrate, migrationInventory, assertSchemaCurrent } from '../src/db/migrate.ts';
import { splitSqlStatements } from '../src/db/sql.ts';
import { sha256Hex } from '../src/hash.ts';
import { verifyManifestIntegrity } from '../src/domain/manifest-signing.ts';
import { exportEvidencePackage } from '../src/domain/evidence-review.ts';

assert.equal(process.env.PACKPROOF_TEST_PURPOSE, 'isolated-m1-synthetic');
const baseline = '/tmp/packproof-m1-baseline/backend';
const old = async name => import(pathToFileURL(`${baseline}/${name}.ts`).href);
const [{ insertUser }, { createTransaction }, { createOrGetProof },
  { commitAttestation }, { finalizeProof }, { MemoryObjectStore }, oldExport] = await Promise.all([
  old('src/domain/users'), old('src/domain/transactions'), old('src/domain/create-proof'),
  old('src/domain/attestations'), old('src/domain/finalize'), old('tests/memory-object-store'),
  old('src/domain/evidence-review'),
]);
const connection = process.env.PACKPROOF_TEST_DATABASE_URL;
assert.ok(connection);
const admin = createPgDatabase(connection);
const schema = `migration_preservation_${randomBytes(8).toString('hex')}`;
await admin.db.query(`CREATE SCHEMA ${schema}`);
const url = new URL(connection);
url.searchParams.set('options', `-c search_path=${schema}`);
const opened = createPgDatabase(url.toString());
const clock = { now: () => new Date('2026-10-20T20:00:00.000Z') };
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const signer = { signManifest: async input => ({ algorithm: 'ECDSA_SHA_256',
  keyId: 'synthetic-migration-only', signedAt: clock.now().toISOString(),
  signatureBase64: sign('sha256', Buffer.from(input.canonicalJson), keys.privateKey).toString('base64') }) };
const store = new MemoryObjectStore();
// Read uncompressed local ZIP entries emitted by PackProof's own bounded ZIP writer.
function zipEntries(bytes) {
  const entries = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString();
    // Streaming entries use a descriptor; the central directory supplies their sizes.
    let central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset);
    let size;
    while (central >= 0) {
      const n = bytes.readUInt16LE(central + 28), e = bytes.readUInt16LE(central + 30), c = bytes.readUInt16LE(central + 32);
      if (bytes.readUInt32LE(central + 42) === offset) { size = bytes.readUInt32LE(central + 20); break; }
      central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), central + 46 + n + e + c);
    }
    assert.notEqual(size, undefined);
    const start = offset + 30 + nameLength + extraLength;
    entries.set(name, bytes.subarray(start, start + size));
    offset = start + size + ((bytes.readUInt16LE(offset + 6) & 8) ? 16 : 0);
  }
  return entries;
}
let success = false;
try {
  const inventory = await migrationInventory(`${baseline}/migrations`);
  assert.equal(inventory.length, 86);
  await migrate(opened.db, `${baseline}/migrations`, { expectedRole: 'packproof' });
  const ssl = (await opened.db.query('SELECT ssl,version AS protocol FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
  assert.equal(ssl.ssl, true);
  const fixtures = [];
  for (const label of ['Merchant A', 'Merchant B']) {
    const user = await insertUser(opened.db, clock);
    const transaction = await createTransaction(opened.db, clock, user, { itemTitle: `SYNTHETIC ${label}` });
    const proof = await createOrGetProof(opened.db, clock, user, transaction.transactionId, { participationPolicy: 'COUNTERPARTY_OPTIONAL' });
    const id = `ev_${randomBytes(12).toString('hex')}`, tenant = `ten_${randomBytes(12).toString('hex')}`;
    const body = Buffer.from(`SYNTHETIC migration preservation ${label}`), objectKey = `fixture/${id}`;
    await store.put(objectKey, body, 'application/octet-stream');
    await opened.db.query("INSERT INTO evidence(id,proof_id,submitted_by,object_key,content_type,byte_size,sha256,created_at,committed_at,validation_status,evidence_type,capture_origin) VALUES($1,$2,$3,$4,'application/octet-stream',$5,$6,$7,$7,'COMMITTED','FULFILLMENT_CAPTURE','LEGACY_UNKNOWN')", [id,proof.proofId,user,objectKey,body.length,sha256Hex(body),clock.now().toISOString()]);
    await opened.db.query("INSERT INTO api_tenants(id,owner_user_id,name,environment,created_at) VALUES($1,$2,$3,'sandbox',$4)", [tenant,user,label,clock.now().toISOString()]);
    await opened.db.query("INSERT INTO api_tenant_proofs(tenant_id,external_id,proof_id,request_hash,created_at) VALUES($1,'ORDER-1001',$2,'synthetic',$3)", [tenant,proof.proofId,clock.now().toISOString()]);
    await commitAttestation(opened.db, clock, user, proof.proofId, { statement: 'PACKED_DESCRIBED_ITEM', relatedEvidenceId: id });
    const final = await finalizeProof(opened.db, clock, user, proof.proofId, signer);
    const exported = await oldExport.exportEvidencePackage(opened.db, clock, store, user, proof.proofId);
    fixtures.push({ user, proofId: proof.proofId, manifest: final.manifest, exported });
  }
  const receiptsBefore = (await opened.db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
  const preflight = [];
  const statements = splitSqlStatements(await readFile(new URL('./organization-preflight.sql', import.meta.url), 'utf8'));
  await opened.db.transaction(async tx => {
    await tx.query('SET TRANSACTION READ ONLY');
    for (const sql of statements) {
      const clean = sql.replace(/--[^\n]*/g, '').trim();
      if (/^(BEGIN|COMMIT)\b/i.test(clean)) continue;
      preflight.push((await tx.query(sql)).rows);
    }
  });
  const transactionDurationsMs = [];
  const measured = { ...opened.db, transaction: async fn => {
    const start = performance.now();
    try { return await opened.db.transaction(fn); }
    finally { transactionDurationsMs.push(performance.now() - start); }
  } };
  const start = performance.now();
  await migrate(measured, undefined, { expectedRole: 'packproof' });
  const migrationElapsedMs = performance.now() - start;
  await assertSchemaCurrent(opened.db);
  const receiptsAfter = (await opened.db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
  assert.equal(receiptsAfter.length, 91);
  assert.deepEqual(receiptsAfter.slice(0, 86), receiptsBefore);
  const records = [];
  for (const fixture of fixtures) {
    const stored = (await opened.db.query('SELECT canonical_json,sha256,signature_base64 FROM final_manifests WHERE proof_id=$1', [fixture.proofId])).rows[0];
    assert.equal(stored.canonical_json, fixture.manifest.canonicalJson);
    assert.equal(stored.sha256, fixture.manifest.sha256);
    assert.equal(stored.signature_base64, fixture.manifest.signature.signatureBase64);
    assert.equal(verifyManifestIntegrity({ canonicalJson: stored.canonical_json, expectedSha256: stored.sha256,
      signature: fixture.manifest.signature, publicKeyPem: keys.publicKey.export({ type:'spki', format:'pem' }).toString() }).signatureValid, true);
    const exportedAfter = await exportEvidencePackage(opened.db, clock, store, fixture.user, fixture.proofId);
    const before = zipEntries(fixture.exported), after = zipEntries(exportedAfter);
    const paths = [...before.keys()].filter(name => ['manifest.json','transaction.json','participants.json','attestations.json','integrity/signatures.json','integrity/evidence.json'].includes(name) || name.startsWith('evidence/'));
    assert.ok(paths.length >= 7);
    const hashes = {};
    for (const name of paths) { assert.deepEqual(after.get(name), before.get(name)); hashes[name] = sha256Hex(before.get(name)); }
    records.push({ proofId: fixture.proofId, manifestSha256: stored.sha256, preservedEntries: hashes,
      beforePackageSha256: sha256Hex(fixture.exported), afterPackageSha256: sha256Hex(exportedAfter) });
  }
  const evidence = { event: 'isolated_migration_preservation_passed', source: process.env.CANDIDATE_SHA,
    baseline: process.env.BASELINE_SHA, schema, ssl, historicalMigrations: 86, currentMigrations: 91,
    migrationElapsedMs, maximumTransactionElapsedMs: Math.max(...transactionDurationsMs), preflight, records,
    limitations: ['Synthetic legacy evidence fixture and software signing; no capture certification',
      'MemoryObjectStore; AWS durability and role boundaries are separate gates',
      'Export audit projections may change; frozen core entries and original media are compared byte for byte',
      'Transaction elapsed time includes queries and lock waits; not a direct lock-hold measurement'] };
  await writeFile('/tmp/packproof-m1-migration-evidence.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  success = true;
} finally {
  await opened.close();
  // Retain the dedicated schema after a failed run for diagnosis; never drop another schema.
  if (success) await admin.db.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.close();
}
