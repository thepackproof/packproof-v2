import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { appendAudit } from '../domain/audit.js';
import { validateTrustPublicKey } from '../domain/signing-trust.js';
import { requireParticipant } from '../domain/proof-access.js';
import { MANIFEST_SIGNATURE_ALGORITHMS, verifyManifestIntegrity, type ManifestSignature, type ManifestSignatureAlgorithm, type ManifestSigner } from '../domain/manifest-signing.js';
import { sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import { canonical, manifestDigest, type CaptureContext, type CaptureManifest } from './core.js';

export const CAPTURE_COMPLETION_SCHEMA = 'packproof.capture-completion/1' as const;

/** Expected values must come from the host's original authenticated launch and server reads. */
export interface CaptureCompletionContext {
  intentId: string;
  captureId: string;
  proofId: string;
  actorId: string;
  transactionId: string;
  transactionDigest: string;
  contextSha256: string;
  captureManifestSha256: string;
  evidenceId: string;
  sourceSha256: string;
  finalManifestId: string;
  finalManifestSha256: string;
  audience: string;
  returnTarget: string;
}

export interface CaptureCompletionPayload extends CaptureCompletionContext {
  schema: typeof CAPTURE_COMPLETION_SCHEMA;
  receiptId: string;
  state: 'FINALIZED';
  issuedAt: string;
}

export interface CaptureCompletionReceipt {
  payload: CaptureCompletionPayload;
  canonicalJson: string;
  sha256: string;
  signature: ManifestSignature;
}

export interface CaptureReceiptTrustKey {
  keyId: string;
  algorithm: ManifestSignatureAlgorithm;
  publicKeyPem: string;
  status: 'ACTIVE' | 'REVOKED';
}

interface ReceiptRow {
  id: string;
  intent_id: string;
  capture_session_id: string;
  proof_id: string;
  actor_user_id: string;
  evidence_id: string;
  final_manifest_id: string;
  issued_at: string | Date;
  canonical_json: string;
  sha256: string;
  signature_json: ManifestSignature;
}

interface BoundRow {
  session_id: string;
  intent_id: string;
  proof_id: string;
  actor_user_id: string;
  context_json: CaptureContext;
  context_sha256: string;
  manifest_json: CaptureManifest | null;
  manifest_sha256: string | null;
}

function ensure(value: unknown, code: string, message: string, status = 409): asserts value {
  if (!value) throw new DomainError(code, message, status);
}

/** Fixed internal destination: no external URL is accepted, fetched, redirected to, or signed. */
export function captureCompletionDestination(intentId: string, proofId: string) {
  ensure(/^[A-Za-z0-9_-]{1,128}$/.test(intentId) && /^[A-Za-z0-9_-]{1,128}$/.test(proofId),
    'CAPTURE_COMPLETION_CONTEXT_INVALID', 'Invalid capture completion destination', 422);
  return { audience: `packproof:capture-intent:${intentId}`, returnTarget: `/proofs/${proofId}` };
}

function receiptView(row: ReceiptRow, binding: BoundRow): CaptureCompletionReceipt {
  let payload: CaptureCompletionPayload;
  try {
    payload = JSON.parse(row.canonical_json) as CaptureCompletionPayload;
    const destination = captureCompletionDestination(binding.intent_id, binding.proof_id);
    ensure(canonical(payload) === row.canonical_json && sha256Hex(row.canonical_json) === row.sha256
      && payload.schema === CAPTURE_COMPLETION_SCHEMA && payload.state === 'FINALIZED'
      && payload.receiptId === row.id && payload.intentId === row.intent_id && payload.intentId === binding.intent_id
      && payload.captureId === row.capture_session_id && payload.captureId === binding.session_id
      && payload.proofId === row.proof_id && payload.proofId === binding.proof_id
      && payload.actorId === row.actor_user_id && payload.actorId === binding.actor_user_id
      && payload.evidenceId === row.evidence_id && payload.finalManifestId === row.final_manifest_id
      && payload.issuedAt === new Date(row.issued_at).toISOString()
      && payload.transactionId === binding.context_json.transactionId && payload.transactionDigest === binding.context_json.transactionDigest
      && payload.contextSha256 === binding.context_sha256 && payload.contextSha256 === sha256Hex(canonical(binding.context_json))
      && payload.captureManifestSha256 === binding.manifest_sha256 && payload.sourceSha256 === binding.manifest_json?.source.sha256
      && payload.audience === destination.audience && payload.returnTarget === destination.returnTarget
      && validSignatureShape(row.signature_json),
    'CAPTURE_COMPLETION_STORED_INVALID', 'The stored completion receipt is inconsistent', 503);
  } catch {
    throw new DomainError('CAPTURE_COMPLETION_STORED_INVALID', 'The stored completion receipt is inconsistent', 503);
  }
  return { payload, canonicalJson: row.canonical_json, sha256: row.sha256, signature: row.signature_json };
}

async function authorizedBinding(db: Database, actor: string, captureId: string, lock = false) {
  const row = (await db.query<BoundRow>(
    `SELECT * FROM capture_engine_sessions WHERE session_id=$1 AND actor_user_id=$2${lock ? ' FOR UPDATE' : ''}`,
    [captureId, actor],
  )).rows[0];
  ensure(row, 'CAPTURE_SESSION_NOT_FOUND', 'Open this recording in its original account', 404);
  await requireParticipant(db, row.proof_id, actor, 'SELLER');
  return row;
}

export async function readCaptureCompletionReceipt(db: Database, actor: string, captureId: string): Promise<CaptureCompletionReceipt> {
  const binding = await authorizedBinding(db, actor, captureId);
  const row = (await db.query<ReceiptRow>(
    'SELECT * FROM capture_completion_receipts WHERE capture_session_id=$1 AND actor_user_id=$2',
    [captureId, actor],
  )).rows[0];
  ensure(row, 'CAPTURE_COMPLETION_NOT_ISSUED', 'A signed completion receipt is not available yet', 404);
  return receiptView(row, binding);
}

/**
 * Authenticated, idempotent issuance over existing finalized state. This never commits,
 * seals, finalizes, changes an intent, or accepts a host's claim that capture succeeded.
 */
export async function issueCaptureCompletionReceipt(
  db: Database, clock: Clock, actor: string, captureId: string, signer?: ManifestSigner,
): Promise<CaptureCompletionReceipt> {
  return db.transaction(async tx => {
    // All competing receipt issuers lock this immutable session; no proof-state locks are needed.
    const binding = await authorizedBinding(tx, actor, captureId, true);
    const existing = (await tx.query<ReceiptRow>(
      'SELECT * FROM capture_completion_receipts WHERE capture_session_id=$1', [captureId],
    )).rows[0];
    if (existing) return receiptView(existing, binding);

    const row = (await tx.query<{
      intent_session_id: string; intent_proof_id: string; intent_actor_id: string; intent_context: Omit<CaptureContext, 'captureId' | 'capabilities'>;
      session_proof_id: string; session_actor_id: string; session_state: string; expected_sha256: string; expected_byte_size: string | number;
      evidence_id: string | null; evidence_session_id: string | null; evidence_proof_id: string | null; evidence_actor_id: string | null;
      validation_status: string | null; source_sha256: string | null; byte_size: string | number | null;
      proof_status: string; proof_manifest_id: string | null; transaction_id: string;
      final_manifest_id: string | null; final_manifest_sha256: string | null; final_canonical_json: string | null;
    }>(`SELECT i.session_id AS intent_session_id,i.proof_id AS intent_proof_id,i.actor_user_id AS intent_actor_id,i.context_json AS intent_context,
        c.proof_id AS session_proof_id,c.actor_user_id AS session_actor_id,c.state AS session_state,c.expected_sha256,c.expected_byte_size,
        e.id AS evidence_id,e.capture_session_id AS evidence_session_id,e.proof_id AS evidence_proof_id,e.submitted_by AS evidence_actor_id,
        e.validation_status,e.sha256 AS source_sha256,e.byte_size,p.status AS proof_status,p.manifest_id AS proof_manifest_id,p.transaction_id,
        m.id AS final_manifest_id,m.sha256 AS final_manifest_sha256,m.canonical_json AS final_canonical_json
      FROM capture_intents i JOIN capture_sessions c ON c.id=i.session_id JOIN proofs p ON p.id=c.proof_id
      LEFT JOIN evidence e ON e.id=c.evidence_id LEFT JOIN final_manifests m ON m.proof_id=p.id WHERE i.id=$1`,
    [binding.intent_id])).rows[0];
    ensure(row && row.session_state === 'COMMITTED' && row.validation_status === 'COMMITTED' && row.proof_status === 'FINALIZED',
      'CAPTURE_COMPLETION_PENDING', 'The original recording must be committed and its Proof finalized before completion');
    const context = binding.context_json;
    const { captureId: _captureId, capabilities: _capabilities, ...originalContext } = context;
    ensure(row.intent_session_id === captureId && row.intent_proof_id === binding.proof_id && row.intent_actor_id === actor
      && row.session_proof_id === binding.proof_id && row.session_actor_id === actor
      && row.evidence_session_id === captureId && row.evidence_proof_id === binding.proof_id && row.evidence_actor_id === actor
      && context.captureId === captureId && context.intentId === binding.intent_id && context.proofId === binding.proof_id
      && context.actorId === actor && context.transactionId === row.transaction_id
      && canonical(originalContext) === canonical(row.intent_context) && sha256Hex(canonical(context)) === binding.context_sha256,
    'CAPTURE_COMPLETION_CONTEXT_INVALID', 'The original capture context does not match this completion');
    ensure(binding.manifest_json && binding.manifest_sha256 && row.source_sha256 && row.evidence_id
      && row.source_sha256 === row.expected_sha256 && row.source_sha256 === binding.manifest_json.source.sha256
      && Number(row.byte_size) === Number(row.expected_byte_size) && Number(row.byte_size) === binding.manifest_json.source.byteSize
      && canonical(binding.manifest_json.context) === canonical(context)
      && await manifestDigest(binding.manifest_json, async value => sha256Hex(value)) === binding.manifest_sha256,
    'CAPTURE_COMPLETION_SOURCE_INVALID', 'The committed original does not match its sealed capture manifest');
    ensure(row.final_manifest_id && row.final_manifest_sha256 && row.final_canonical_json
      && row.proof_manifest_id === row.final_manifest_id && sha256Hex(row.final_canonical_json) === row.final_manifest_sha256,
    'CAPTURE_COMPLETION_ROOT_INVALID', 'The finalized Proof manifest is unavailable or inconsistent');
    const root = JSON.parse(row.final_canonical_json) as { proofId?: string; transactionId?: string;
      captureManifests?: { captureId: string; sha256: string; manifest: unknown }[];
      evidence?: { evidenceId: string; sha256: string; submittedBy: string; capture?: { sessionId: string } }[] };
    ensure(root.proofId === binding.proof_id && root.transactionId === row.transaction_id
      && root.captureManifests?.some(entry => entry.captureId === captureId && entry.sha256 === binding.manifest_sha256
        && canonical(entry.manifest) === canonical(binding.manifest_json))
      && root.evidence?.some(entry => entry.evidenceId === row.evidence_id && entry.sha256 === row.source_sha256
        && entry.submittedBy === actor && entry.capture?.sessionId === captureId),
    'CAPTURE_COMPLETION_ROOT_INVALID', 'The finalized Proof does not include this committed recording');
    ensure(signer, 'CAPTURE_COMPLETION_SIGNING_UNAVAILABLE', 'Signed completion is temporarily unavailable; retry later', 503);

    const payload: CaptureCompletionPayload = {
      schema: CAPTURE_COMPLETION_SCHEMA, receiptId: newId('ccr'), state: 'FINALIZED', issuedAt: clock.now().toISOString(),
      intentId: binding.intent_id, captureId, proofId: binding.proof_id, actorId: actor,
      transactionId: context.transactionId, transactionDigest: context.transactionDigest, contextSha256: binding.context_sha256,
      captureManifestSha256: binding.manifest_sha256, evidenceId: row.evidence_id, sourceSha256: row.source_sha256,
      finalManifestId: row.final_manifest_id, finalManifestSha256: row.final_manifest_sha256,
      ...captureCompletionDestination(binding.intent_id, binding.proof_id),
    };
    const canonicalJson = canonical(payload);
    const digest = sha256Hex(canonicalJson);
    const signature = await signer.signManifest({ proofId: binding.proof_id, manifestId: payload.receiptId, canonicalJson, sha256: digest });
    ensure(validSignatureShape(signature), 'CAPTURE_COMPLETION_SIGNING_UNAVAILABLE', 'The completion receipt could not be signed', 503);
    await tx.query(`INSERT INTO capture_completion_receipts
      (id,intent_id,capture_session_id,proof_id,actor_user_id,evidence_id,final_manifest_id,canonical_json,sha256,signature_json,issued_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
    [payload.receiptId,payload.intentId,captureId,payload.proofId,actor,payload.evidenceId,payload.finalManifestId,canonicalJson,digest,JSON.stringify(signature),payload.issuedAt]);
    await appendAudit(tx, { proofId: payload.proofId, actorUserId: actor, eventType: 'CAPTURE_COMPLETION_RECEIPT_ISSUED',
      eventData: { receiptId: payload.receiptId, intentId: payload.intentId, captureId, evidenceId: payload.evidenceId,
        receiptSha256: digest, captureManifestSha256: payload.captureManifestSha256, finalManifestSha256: payload.finalManifestSha256 },
      at: new Date(payload.issuedAt) });
    return { payload, canonicalJson, sha256: digest, signature };
  });
}

const contextKeys = ['intentId','captureId','proofId','actorId','transactionId','transactionDigest','contextSha256',
  'captureManifestSha256','evidenceId','sourceSha256','finalManifestId','finalManifestSha256','audience','returnTarget'] as const;

function validSignatureShape(value: unknown): value is ManifestSignature {
  const s = value as ManifestSignature | null;
  return !!s && (MANIFEST_SIGNATURE_ALGORITHMS as readonly string[]).includes(s.algorithm)
    && typeof s.keyId === 'string' && s.keyId.length > 0 && s.keyId.length <= 200
    && typeof s.signatureBase64 === 'string' && s.signatureBase64.length > 0 && s.signatureBase64.length <= 16384
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s.signatureBase64)
    && typeof s.signedAt === 'string' && Number.isFinite(Date.parse(s.signedAt));
}

/** Does not trust keys, destinations, or expected context taken from the receipt itself. */
export function verifyCaptureCompletionReceipt(
  value: unknown, expected: CaptureCompletionContext, trustedKey: CaptureReceiptTrustKey,
): boolean {
  try {
    const receipt = value as CaptureCompletionReceipt;
    const payload = receipt?.payload;
    if (!payload || payload.schema !== CAPTURE_COMPLETION_SCHEMA || payload.state !== 'FINALIZED'
      || typeof payload.receiptId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.receiptId)
      || typeof payload.issuedAt !== 'string' || !Number.isFinite(Date.parse(payload.issuedAt))
      || typeof receipt.canonicalJson !== 'string' || receipt.canonicalJson.length > 16384
      || typeof receipt.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sha256)
      || !validSignatureShape(receipt.signature) || !trustedKey || trustedKey.status !== 'ACTIVE'
      || receipt.signature.keyId !== trustedKey.keyId || receipt.signature.algorithm !== trustedKey.algorithm
      || typeof trustedKey.publicKeyPem !== 'string' || !trustedKey.publicKeyPem || trustedKey.publicKeyPem.includes('PRIVATE')
      || !expected || contextKeys.some(key => typeof expected[key] !== 'string' || !expected[key] || payload[key] !== expected[key])) return false;
    const destination = captureCompletionDestination(expected.intentId, expected.proofId);
    if (payload.audience !== destination.audience || payload.returnTarget !== destination.returnTarget
      || Object.keys(payload).sort().join(',') !== [...contextKeys,'schema','receiptId','state','issuedAt'].sort().join(',')
      || canonical(payload) !== receipt.canonicalJson) return false;
    for (const key of ['transactionDigest','contextSha256','captureManifestSha256','sourceSha256','finalManifestSha256'] as const)
      if (!/^[a-f0-9]{64}$/.test(payload[key])) return false;
    validateTrustPublicKey(trustedKey.publicKeyPem, trustedKey.algorithm);
    const verified = verifyManifestIntegrity({ canonicalJson: receipt.canonicalJson, expectedSha256: receipt.sha256,
      signature: receipt.signature, publicKeyPem: trustedKey.publicKeyPem });
    return verified.digestValid && verified.signatureValid === true;
  } catch { return false; }
}
