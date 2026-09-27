/** Live staging only. No account creation, mail, billing writes, customer data, carriers or evidence deletion. */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AuthService } from '../src/main/auth.js';
import { DesktopApi, DesktopApiError } from '../src/main/api.js';
import { DesktopEvidenceTransport } from '../src/main/evidence-api.js';
import { loadConfig } from '../src/main/config.js';
import type { CaptureMetadata } from '../src/main/evidence/types.js';

const mode = process.argv[2] ?? '--preflight';
if (mode === '--help') {
  console.log('Usage: node scripts/run-staging-acceptance.mjs [--preflight|--execute-protocol-fixture|--execute-native-host]');
  console.log('See desktop/docs/staging-acceptance.md for environment inputs and the required migration receipt.');
  process.exit(0);
}
function ensure(condition: unknown, code: string): asserts condition { if (!condition) throw Object.assign(new Error(code), { code }); }
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const runId = randomUUID();
const reportPath = resolve('artifacts', `staging-acceptance-${runId}.json`);
type FixtureRecord = { fixture: string; sha256: string; byteSize: number; proofId?: string; captureSessionId?: string; evidenceId?: string; manifestSha256?: string; checks: string[] };
const report: { schemaVersion: number; runId: string; mode: string; status: string; startedAt: string; completedAt?: string; actualHostPlatform: string; desktopPlatformClaim?: string; simulatedPlatformClaim: boolean; sourceCommit?: string; migration?: { name: string; sha256: string; receiptSha256: string }; checks: string[]; fixtures: FixtureRecord[]; cleanup: { shareLinksRevoked: boolean; localSessionCleared: boolean; accountDisabledByOperator: boolean; pendingAccessLinkIds?: string[] }; failure?: { stage: string; code: string; httpStatus?: number }; limitations: string[] } = {
  schemaVersion: 1, runId, mode, status: 'RUNNING', startedAt: new Date().toISOString(), actualHostPlatform: process.platform,
  simulatedPlatformClaim: mode === '--execute-protocol-fixture', checks: [], fixtures: [],
  cleanup: { shareLinksRevoked: true, localSessionCleared: false, accountDisabledByOperator: false },
  limitations: ['Synthetic source fixtures are not shipments and are never submitted to a recipient.', 'This verifies authenticated live API contracts, not the Electron installer, webcam, scanner, OS credential vault or a real packing operation.', 'No marketplace connection, live carrier, customer account, billing enrollment or billing adjustment is used.', 'Test Proofs and committed evidence are retained. Disable the dedicated Cognito test user separately after checking cleanup.'],
};
let stage = 'configuration';
let auth: AuthService | undefined;
let api: DesktopApi | undefined;
let sessionBytes: string | null = null;
const links = new Map<string, { proofId: string; token: string }>();
async function checkpoint() { await writeFile(`${reportPath}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); await rename(`${reportPath}.tmp`, reportPath); }
async function binary(response: Response): Promise<Buffer> { ensure(response.ok, 'DOWNLOAD_FAILED'); return Buffer.from(await response.arrayBuffer()); }
function safeCode(value: unknown) { return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : 'ACCEPTANCE_CHECK_FAILED'; }

try {
  ensure(['--preflight', '--execute-protocol-fixture', '--execute-native-host'].includes(mode), 'INVALID_EXECUTION_MODE');
  ensure(process.env.APP_ENV === 'staging', 'STAGING_ENVIRONMENT_REQUIRED');
  const config = loadConfig(process.env);
  ensure(config.channel === 'staging' && config.apiBaseUrl.startsWith('https://'), 'STAGING_HTTPS_REQUIRED');
  const expectedCommit = process.env.PACKPROOF_SMOKE_EXPECTED_COMMIT;
  ensure(expectedCommit && /^[a-f0-9]{40}$/i.test(expectedCommit), 'EXPECTED_SOURCE_COMMIT_REQUIRED');
  const receiptPath = process.env.PACKPROOF_SMOKE_MIGRATION_RECEIPT;
  ensure(receiptPath, 'MIGRATION_RECEIPT_REQUIRED');
  const receiptBytes = await readFile(receiptPath);
  const receipt = JSON.parse(receiptBytes.toString()) as { environment?: string; apiBaseUrl?: string; sourceCommit?: string; verifiedAt?: string; migrations?: Array<{ name: string; sha256: string; applied: boolean }> };
  ensure(receipt.environment === 'staging' && receipt.apiBaseUrl?.replace(/\/$/, '') === config.apiBaseUrl && receipt.sourceCommit === expectedCommit, 'MIGRATION_RECEIPT_SCOPE_MISMATCH');
  ensure(receipt.verifiedAt && Number.isFinite(Date.parse(receipt.verifiedAt)) && Date.now() - Date.parse(receipt.verifiedAt) < 86_400_000 && Date.parse(receipt.verifiedAt) <= Date.now() + 60_000, 'FRESH_MIGRATION_RECEIPT_REQUIRED');
  const migrationName = '074_desktop_capture_registration';
  const migrationHash = hash(await readFile(resolve('../backend/migrations', `${migrationName}.sql`)));
  const migration = receipt.migrations?.find(value => value.name === migrationName);
  ensure(migration?.applied === true && migration.sha256 === migrationHash, 'DESKTOP_MIGRATION_CHECKSUM_MISMATCH');
  report.migration = { name: migrationName, sha256: migrationHash, receiptSha256: hash(receiptBytes) };
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, '{}\n', { mode: 0o600, flag: 'wx' });
  await checkpoint();
  const publicGet = async (path: string) => {
    const result = await fetch(`${config.apiBaseUrl}${path}`, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/json' } });
    ensure(result.ok, 'PUBLIC_PREFLIGHT_REQUEST_FAILED'); return result.json();
  };
  stage = 'public_preflight';
  const [meta, ready, capabilities] = await Promise.all([publicGet('/meta'), publicGet('/ready'), publicGet('/capabilities')]);
  ensure(meta.environment === 'staging' && meta.commit === expectedCommit, 'DEPLOYED_RELEASE_MISMATCH');
  ensure(ready.status === 'ok' || ready.status === 'ready', 'API_NOT_READY');
  ensure(Array.isArray(capabilities.desktopCapture?.registrationVersions) && capabilities.desktopCapture.registrationVersions.includes(1) && capabilities.desktopCapture.client === 'DESKTOP_CAMERA' && capabilities.desktopCapture.timingProvenance === 'CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED', 'DESKTOP_CAPABILITY_REQUIRED');
  report.sourceCommit = meta.commit;
  report.checks.push('migration-receipt-and-local-sql-checksum', 'exact-staging-release', 'api-readiness', 'desktop-provenance-capability');
  if (mode === '--preflight') {
    report.status = 'PREFLIGHT_PASS';
    report.limitations.push('Preflight made no authenticated request or remote mutation.');
  } else {
    const platformClaim = mode === '--execute-protocol-fixture' ? 'win32' : process.platform;
    ensure(platformClaim === 'win32' || platformClaim === 'darwin', 'NATIVE_HOST_REQUIRED');
    report.desktopPlatformClaim = platformClaim;
    if (mode === '--execute-protocol-fixture') report.limitations.push('The win32 request metadata is an explicitly simulated protocol fixture. Actual host platform is recorded separately; this is not Windows or macOS native acceptance.');
    const email = process.env.PACKPROOF_SMOKE_EMAIL;
    const password = process.env.PACKPROOF_SMOKE_PASSWORD;
    ensure(email && /^desktop-staging-[a-z0-9-]{8,80}@example\.invalid$/i.test(email), 'DEDICATED_TEST_ACCOUNT_REQUIRED');
    ensure(password && password.length >= 12, 'TEST_CREDENTIALS_REQUIRED');
    auth = new AuthService({ config, store: { read: async () => sessionBytes, write: async value => { sessionBytes = value; }, clear: async () => { sessionBytes = null; } } });
    stage = 'cognito_login';
    const session = await auth.signIn({ email, password });
    ensure(session.email === email.toLowerCase() && session.profile.userId === session.userId, 'BACKEND_ACCOUNT_BINDING_FAILED');
    api = new DesktopApi({ config, getAccountId: () => auth!.getAccountId(), getToken: force => auth!.getAccessToken(force) });
    await auth.getAccessToken(true);
    report.checks.push('real-cognito-password-sign-in', 'backend-internal-account-binding', 'real-cognito-refresh');
    const privateGet = async (path: string) => {
      const response = await fetch(`${config.apiBaseUrl}${path}`, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${await auth!.getAccessToken()}`, Accept: 'application/json' } });
      ensure(response.ok, 'ACCOUNT_PREFLIGHT_FAILED'); return response.json();
    };
    stage = 'fresh_account_gate';
    const [existingProofs, usage, billing] = await Promise.all([api.listProofs(), privateGet('/me/usage'), privateGet('/me/billing/status')]);
    ensure(existingProofs.length === 0 && usage.currentOffer === null && usage.finalizedProofs === 0 && usage.automaticChargesEnabled === false && Array.isArray(billing.subscriptions) && billing.subscriptions.length === 0 && billing.pendingCheckout === null, 'FRESH_UNENROLLED_ACCOUNT_REQUIRED');
    report.checks.push('fresh-account-no-existing-proofs', 'no-priced-offer-subscription-or-checkout', 'no-billing-grants-or-adjustments');
    await checkpoint();
    const transport = new DesktopEvidenceTransport(api);
    const fixtures = [ { file: 'camera-recording.mp4', type: 'video/mp4', durationMs: 200 }, { file: 'desktop-streaming.webm', type: 'video/webm', durationMs: 1000 } ];
    for (const fixture of fixtures) {
      const bytes = await readFile(resolve('../backend/tests/fixtures', fixture.file));
      const row: FixtureRecord = { fixture: fixture.file, sha256: hash(bytes), byteSize: bytes.length, checks: [] };
      report.fixtures.push(row);
      stage = `create_synthetic_proof_${fixture.type}`;
      const proof = await api.createProof({ externalReference: `SYNTHETIC-DESKTOP-${runId}-${fixture.file}`, itemTitle: 'SYNTHETIC DESKTOP API TEST - NOT A SHIPMENT', itemDescription: 'Automated staging contract fixture. No physical packing or shipment occurred. Desktop metadata and the shipping declaration test API behavior only. Never submit this test record to a recipient or claim.', quantity: 1 });
      row.proofId = proof.proofId; await checkpoint();
      ensure(proof.status === 'READY_FOR_EVIDENCE', 'PROOF_NOT_READY');
      const identity = { accountId: session.userId, proofId: proof.proofId, jobId: `desktop-smoke-${runId}-${fixture.file}` };
      const reportedEnd = new Date();
      const metadata: CaptureMetadata = { captureSource: 'DESKTOP_CAMERA', appVersion: '1.0.0', installationId: `synthetic-smoke-${runId}`, platform: platformClaim, startedAt: new Date(reportedEnd.getTime() - fixture.durationMs).toISOString(), endedAt: reportedEnd.toISOString(), camera: 'SYNTHETIC SOURCE FIXTURE - NO CAMERA USED', offline: false, detections: [], provenance: 'CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED' };
      // These are disclosed request-fixture timestamps, not measurements of a physical recording.
      const recording = { ...identity, sha256: row.sha256, byteSize: bytes.length, mimeType: fixture.type, recordedDurationMs: fixture.durationMs, metadata };
      stage = `register_${fixture.type}`;
      const capture = await transport.registerCapture(recording, AbortSignal.timeout(120_000));
      ensure(capture.id, 'SERVER_CAPTURE_ID_REQUIRED'); row.captureSessionId = capture.id; await checkpoint();
      ensure((await transport.registerCapture(recording, AbortSignal.timeout(120_000))).id === capture.id, 'CAPTURE_REPLAY_CHANGED_ID');
      row.checks.push('honest-post-capture-registration', 'stable-registration-replay');
      stage = `initialize_upload_${fixture.type}`;
      const uploadInput = { ...recording, captureSessionId: capture.id };
      const upload = await transport.initializeUpload(uploadInput, AbortSignal.timeout(120_000));
      row.evidenceId = upload.evidenceId; await checkpoint();
      ensure((await transport.initializeUpload(uploadInput, AbortSignal.timeout(120_000))).evidenceId === upload.evidenceId, 'UPLOAD_REPLAY_CHANGED_ID');
      const uploadIdentity = { ...identity, evidenceId: upload.evidenceId };
      const state = await transport.inspectUpload(uploadIdentity, AbortSignal.timeout(60_000));
      ensure(state.status === 'PENDING' && state.parts?.length === 0 && Number.isSafeInteger(state.partSize) && state.partSize! > 0, 'INITIAL_PART_STATE_INVALID');
      stage = `upload_${fixture.type}`;
      for (let offset = 0, partNumber = 1; offset < bytes.length; offset += state.partSize!, partNumber++) {
        const part = bytes.subarray(offset, offset + state.partSize!);
        await transport.uploadPart({ ...uploadIdentity, partNumber, bytes: part, sha256: hash(part) }, AbortSignal.timeout(120_000));
      }
      // New transport instance verifies remote resumability independent of prior in-memory state.
      const recovered = await new DesktopEvidenceTransport(api).inspectUpload(uploadIdentity, AbortSignal.timeout(60_000));
      ensure(recovered.parts?.length === Math.ceil(bytes.length / state.partSize!), 'RECOVERED_PARTS_MISSING');
      const expected = { ...uploadIdentity, sha256: row.sha256, byteSize: bytes.length };
      await transport.completeUpload(expected, AbortSignal.timeout(120_000));
      await transport.commitUpload(expected, AbortSignal.timeout(120_000));
      const committed = await transport.inspectUpload(uploadIdentity, AbortSignal.timeout(60_000));
      ensure(committed.status === 'COMMITTED' && committed.sha256 === row.sha256 && committed.byteSize === bytes.length, 'COMMIT_RECEIPT_MISMATCH');
      row.checks.push('stable-upload-initialization', 'multipart-remote-recovery', 'server-assembly-digest', 'committed-original-digest'); await checkpoint();
      stage = `finalize_${fixture.type}`;
      const deadline = Date.now() + 120_000;
      while (true) {
        try { await transport.attestAndFinalize({ ...uploadIdentity, captureSessionId: capture.id, statement: 'PACKED_DESCRIBED_ITEM' }, AbortSignal.timeout(60_000)); break; }
        catch (error) { if (!(error instanceof DesktopApiError) || !['FINALIZATION_PENDING', 'PRESERVATION_PENDING'].includes(error.code) || Date.now() > deadline) throw error; await new Promise(done => setTimeout(done, 2000)); }
      }
      const final = await api.getProof(proof.proofId);
      ensure(final.status === 'FINALIZED', 'FINALIZATION_NOT_CONFIRMED');
      const evidence = final.evidence.find(value => value.evidenceId === upload.evidenceId) as unknown as Record<string, unknown>;
      ensure(evidence?.captureOrigin === 'CLIENT_REPORTED_DESKTOP_CAPTURE' && evidence.captureRegistrationTiming === 'POST_CAPTURE_CLIENT_REPORTED', 'DESKTOP_PROVENANCE_INCORRECT');
      const manifest = await api.getManifest(proof.proofId);
      ensure(hash(manifest.canonicalJson) === manifest.sha256, 'MANIFEST_DIGEST_MISMATCH');
      ensure((await api.finalizeProof(proof.proofId)).manifest?.sha256 === manifest.sha256, 'FROZEN_MANIFEST_CHANGED');
      row.manifestSha256 = manifest.sha256;
      row.checks.push('synthetic-explicit-shipping-declaration', 'authoritative-finalization', 'honest-desktop-provenance', 'frozen-manifest-replay');
      const playback = await binary(await api.getEvidence(proof.proofId, upload.evidenceId));
      ensure(hash(playback) === row.sha256, 'PLAYBACK_BYTES_CHANGED');
      const ranged = await api.getEvidence(proof.proofId, upload.evidenceId, undefined, 'bytes=0-31');
      ensure(ranged.status === 206 && (await binary(ranged)).equals(bytes.subarray(0, 32)), 'VIDEO_RANGE_FAILED');
      const exported = await binary(await api.exportProofPackage(proof.proofId));
      ensure(exported.subarray(0, 2).toString() === 'PK', 'EXPORT_NOT_ZIP');
      row.checks.push('exact-owner-playback', 'byte-range-seeking', 'owner-export-zip');
      stage = `share_${fixture.type}`;
      const shared = await api.createAccessLink(proof.proofId);
      ensure(shared.token && shared.accessLinkId, 'SHARE_LINK_INCOMPLETE');
      links.set(shared.accessLinkId, { proofId: proof.proofId, token: shared.token }); report.cleanup.shareLinksRevoked = false;
      await checkpoint();
      const guest = await fetch(`${config.apiBaseUrl}/public/proofs/${encodeURIComponent(shared.token)}`, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
      ensure(guest.ok, 'PUBLIC_SHARE_READ_FAILED'); await guest.body?.cancel();
      const guestEvidence = await fetch(`${config.apiBaseUrl}/public/proofs/${encodeURIComponent(shared.token)}/evidence/${encodeURIComponent(upload.evidenceId)}`, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
      ensure(hash(await binary(guestEvidence)) === row.sha256, 'PUBLIC_EVIDENCE_BYTES_CHANGED');
      await api.revokeAccessLink(proof.proofId, shared.accessLinkId);
      const revoked = await fetch(`${config.apiBaseUrl}/public/proofs/${encodeURIComponent(shared.token)}`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      ensure(revoked.status === 404, 'SHARE_REVOCATION_NOT_CONFIRMED'); await revoked.body?.cancel();
      links.delete(shared.accessLinkId); report.cleanup.shareLinksRevoked = links.size === 0;
      row.checks.push('public-link-and-exact-evidence', 'public-link-revocation'); await checkpoint();
    }
    report.status = 'PASS';
  }
} catch (error) {
  report.status = 'FAIL'; report.failure = { stage, code: safeCode((error as { code?: unknown }).code), ...(Number.isInteger((error as { status?: number }).status) ? { httpStatus: (error as { status: number }).status } : {}) };
  process.exitCode = 1;
} finally {
  for (const [linkId, link] of links) {
    try { await api?.revokeAccessLink(link.proofId, linkId); links.delete(linkId); } catch { /* Report the remaining links for operator cleanup without logging bearer tokens. */ }
  }
  report.cleanup.shareLinksRevoked = links.size === 0;
  if (links.size > 0) {
    report.cleanup.pendingAccessLinkIds = [...links.keys()];
    report.status = 'FAIL';
    report.failure ??= { stage: 'cleanup', code: 'SHARE_LINK_CLEANUP_FAILED' };
    process.exitCode = 1;
  }
  await auth?.signOut().catch(() => {}); sessionBytes = null;
  report.cleanup.localSessionCleared = true;
  report.completedAt = new Date().toISOString();
  try { await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 }); await checkpoint(); }
  catch { process.exitCode = 1; console.error(JSON.stringify({ status: 'FAIL', code: 'REPORT_WRITE_FAILED' })); }
  console.log(JSON.stringify({ status: report.status, runId, reportPath, fixtureCount: report.fixtures.length, ...(report.failure ? { failure: report.failure } : {}), cleanup: report.cleanup }));
}
