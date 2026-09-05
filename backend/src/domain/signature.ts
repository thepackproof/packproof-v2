import type { Database } from "../db/database.js";
import type { Clock } from "../clock.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { newId } from "../ids.js";
import { DomainError } from "./errors.js";
import { loadProof, requireParticipant } from "./proof-access.js";
import { requireCommerceAccess } from "./commerce-lifecycle.js";
import { getCanonicalProof, type CanonicalProof } from "./canonical-proof.js";
import type { ChronologyEntry } from "./chronology.js";
import { appendAudit } from "./audit.js";
import { sellerCorrectedFields } from "./provenance.js";
import { resolveDisclosureContext, getDisclosureProjection } from "./disclosure.js";
import { readCaptureClientContext, type ClientCaptureContext } from "./capture-sessions.js";

type Input = Record<string, unknown>;
type Stored = { id: string; payload_json: string; sha256: string; created_at: string | Date };
const MAX_ANCHORS = 300;
const MAX_MEDIA = 200;
const MAX_EVENTS = 1000;
const MAX_RECORDING_MS = 6 * 60 * 60 * 1000;
const FIELDS = ["status", "order", "shipping", "evidence", "statements"] as const;
export type SignatureFeature = "replay" | "ask" | "cases" | "compare" | "history";
export function signatureCapabilities() {
  const enabled = (feature: SignatureFeature) => !["0", "false", "off"].includes((process.env[`PACKPROOF_FEATURE_${feature.toUpperCase()}`] ?? "true").toLowerCase());
  return { replay: enabled("replay"), ask: enabled("ask"), cases: enabled("cases"), compare: enabled("compare"), history: enabled("history"), paidAI: false as const };
}
function requireFeature(feature: SignatureFeature) {
  if (!signatureCapabilities()[feature]) fail("SIGNATURE_FEATURE_DISABLED", "This optional feature is temporarily unavailable. Original evidence remains available.", 503);
}
export async function recordSignatureUsage(db: Database, clock: Clock, userId: string, proofId: string, feature: SignatureFeature, failed: boolean, processingMs: number, servedBytes: number) {
  await requireSignatureAccess(db, proofId, userId);
  await db.query(`INSERT INTO signature_usage_daily(proof_id,actor_user_id,feature,usage_day,requests,failures,processing_ms,served_bytes)
    VALUES($1,$2,$3,$4,1,$5,$6,$7) ON CONFLICT(proof_id,actor_user_id,feature,usage_day) DO UPDATE SET
    requests=signature_usage_daily.requests+1,failures=signature_usage_daily.failures+EXCLUDED.failures,
    processing_ms=signature_usage_daily.processing_ms+EXCLUDED.processing_ms,served_bytes=signature_usage_daily.served_bytes+EXCLUDED.served_bytes`,
    [proofId,userId,feature,clock.now().toISOString().slice(0,10),failed?1:0,Math.max(0,Math.round(processingMs)),Math.max(0,Math.round(servedBytes))]);
}
export async function getSignatureUsage(db: Database, userId: string, proofId: string) {
  await requireSignatureAccess(db, proofId, userId);
  const days = await db.query(`SELECT feature,usage_day::text AS day,requests,failures,processing_ms AS "processingMs",served_bytes AS "servedBytes"
    FROM signature_usage_daily WHERE proof_id=$1 AND actor_user_id=$2 ORDER BY usage_day DESC,feature LIMIT 150`, [proofId,userId]);
  return { days: days.rows, modelTokens: 0, paidAI: false, limitations: "Processing and served bytes are measured request totals; infrastructure charges require billing reconciliation." };
}
export const CASE_TEMPLATES = {
  MISSING_CONTENTS: { title: "Reported missing contents", terms: /item|packing|box|seal|label/i },
  WRONG_ITEM: { title: "Reported wrong item", terms: /item|identifier|serial|label|reverse/i },
  CONDITION_RETURN: { title: "Reported condition or return difference", terms: /condition|item|reverse|accessor|return|receipt/i },
} as const;
export type CaseTemplate = keyof typeof CASE_TEMPLATES;
export interface SignatureAnchor {
  schema: "packproof.evidence-anchor.v1";
  anchorId: string;
  proofId: string;
  evidenceId: string | null;
  stageId: string | null;
  eventId: string | null;
  sourceHash: string;
  sourceVersion: string;
  captureSessionId?: string | null;
  recipeVersion?: string | null;
  startMs: number | null;
  endMs: number | null;
  label: string;
  sourceType: "USER_MARKED" | "SCANNER_TRIGGERED";
  sourceCategory: "USER_MARKED_OBSERVATION" | "SCANNER_OBSERVATION";
  timeBasis: "RECORDING_ELAPSED" | "SOURCE_EVENT";
  rangeVerification: "VERIFIED_SOURCE_DURATION" | "DURATION_UNAVAILABLE" | "NOT_APPLICABLE";
  supersedesId: string | null;
  authorUserId: string;
  createdAt: string;
}
export interface SignatureMedia {
  evidenceId: string;
  stageId: string | null;
  stageType: string | null;
  sha256: string;
  sourceVersion: string;
  contentType: string;
  byteSize: number;
  committedAt: string;
  capturedDurationMs: number | null;
  captureSessionId?: string | null;
  clientReportedCapture?: ClientCaptureContext | null;
}
export interface SignatureSnapshotData {
  schema: "packproof.signature-snapshot.v1";
  proofId: string;
  proofVersion: number;
  manifestSha256: string | null;
  status: string;
  audience?: "PARTICIPANT" | "RECEIVER";
  sourceAccess?: { outboundOriginals: "AVAILABLE" | "WITHHELD_BY_SCOPE"; outboundView: string };
  order: { itemTitle: string | null; itemDescription: string | null; quantity: number | null; source: string; fieldSources?: Record<string, string> };
  shipping: { carrier: string | null; events: SignatureEvent[] };
  evidence: SignatureMedia[];
  statements: Array<{ attestationId: string; statement: string; source: string }>;
  anchors: SignatureAnchor[];
  chronology: SignatureEvent[];
  observations?: SignatureComparisonObservation[];
  limitations: string[];
}
export interface SignatureComparisonObservation {
  comparisonId: string;
  outboundAnchorId: string;
  inboundAnchorId: string;
  state: string;
  note: string;
  supersedesId: string | null;
  source: "USER_MARKED_OBSERVATION";
  authorUserId: string;
  createdAt: string;
}
export interface SignatureEvent {
  eventId: string;
  eventType: string;
  occurredAt: string;
  source: string;
  provider: string | null;
  title: string;
  sourceHash?: string;
  sourceVersion?: string;
}
export interface SignatureSnapshot {
  snapshotId: string;
  sha256: string;
  createdAt: string;
  data: SignatureSnapshotData;
}
export interface SignatureCitation {
  kind: "FIELD" | "EVENT" | "MEDIA" | "ANCHOR";
  id: string;
  source: string;
  label: string;
}
export interface CaseScope { fields: string[]; evidenceIds: string[] }
export interface SignatureCasePreview {
  schema: "packproof.case-packet.v1";
  proofId: string;
  template: CaseTemplate;
  templateVersion: "1";
  title: string;
  summary: string;
  snapshotId: string;
  snapshotSha256: string;
  coreManifestSha256: string | null;
  scope: CaseScope;
  status: string | null;
  order: SignatureSnapshotData["order"] | null;
  shipping: SignatureSnapshotData["shipping"] | null;
  evidence: SignatureMedia[];
  anchors: SignatureAnchor[];
  statements: SignatureSnapshotData["statements"];
  observations?: SignatureComparisonObservation[];
  notes: { text: string; source: "USER_SUPPLIED_NOTE" } | null;
  gaps: string[];
  limitations: string[];
}

function fail(code: string, message: string, status = 400): never { throw new DomainError(code, message, status); }
function text(value: unknown, name: string, max = 200, optional = false): string {
  if (optional && (value == null || (typeof value === "string" && !value.trim()))) return "";
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    fail("INVALID_SIGNATURE_INPUT", `${name} must contain 1–${max} characters`);
  return value.trim();
}
function optionalId(value: unknown): string | null { return value == null ? null : text(value, "Reference"); }
function iso(value: string | Date): string { return new Date(value).toISOString(); }
function decode<T>(row: Stored): T { return JSON.parse(row.payload_json) as T; }
function signatureEvent(proof: CanonicalProof, event: ChronologyEntry): SignatureEvent {
  // Hash the original immutable source, not a mutable display label derived from order context.
  const original = proof.events.find(e => e.eventId === event.id) ?? proof.shipmentObservations.events.find(e => e.id === event.id);
  if (!original) fail("EVENT_SOURCE_NOT_FOUND", "Chronology entry has no original source", 409);
  const sourceHash = sha256Hex(canonicalize(original));
  return { eventId: event.id, eventType: event.eventType, occurredAt: event.occurredAt,
    source: event.source, provider: event.provider ?? null, title: event.title,
    sourceHash, sourceVersion: `sha256:${sourceHash}` };
}

/** Only contributor access is accepted here. A guest grant never becomes a participant. */
export async function requireSignatureAccess(db: Database, proofId: string, userId: string) {
  const proof = await loadProof(db, proofId);
  if (proof.status === "FINALIZED" && proof.workflow_type === "COMMERCE_SALE")
    return requireCommerceAccess(db, proofId, userId);
  return (await requireParticipant(db, proofId, userId)).role;
}
async function hasRootSourceAccess(db: Database, proofId: string, userId: string) {
  return Boolean((await db.query("SELECT 1 FROM proof_participants WHERE proof_id=$1 AND user_id=$2", [proofId, userId])).rows[0]);
}

async function listAnchors(db: Database, proofId: string): Promise<SignatureAnchor[]> {
  const rows = await db.query<Stored>("SELECT * FROM evidence_anchors WHERE proof_id=$1 ORDER BY created_at,id LIMIT $2", [proofId, MAX_ANCHORS + 1]);
  if (rows.rows.length > MAX_ANCHORS) fail("SIGNATURE_LIMIT", "This Proof has reached the chapter limit", 413);
  return rows.rows.map(row => decode<SignatureAnchor>(row));
}
async function sourceMedia(db: Database, proofId: string, evidenceId: string, stageId: string | null): Promise<SignatureMedia> {
  const row = stageId
    ? (await db.query<{ id: string; sha256: string; content_type: string; byte_size: string; committed_at: string | Date; stage_type: string }>(
      `SELECT e.*,s.stage_type FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id
       WHERE s.proof_id=$1 AND s.id=$2 AND e.id=$3 AND e.committed_at IS NOT NULL AND e.discarded_at IS NULL`, [proofId, stageId, evidenceId])).rows[0]
    : (await db.query<{ id: string; sha256: string; content_type: string; byte_size: string; committed_at: string | Date; stage_type?: string; captured_duration_ms?: number | string | null }>(
      "SELECT * FROM evidence WHERE proof_id=$1 AND id=$2 AND validation_status='COMMITTED'", [proofId, evidenceId])).rows[0];
  if (!row?.sha256) fail("ANCHOR_SOURCE_NOT_FOUND", "A committed source in this Proof is required", 404);
  const captureSessionId = "capture_session_id" in row && row.capture_session_id != null ? String(row.capture_session_id) : null;
  return { evidenceId, stageId, stageType: row.stage_type ?? null, sha256: row.sha256,
    sourceVersion: `sha256:${row.sha256}`, contentType: row.content_type,
    byteSize: Number(row.byte_size), committedAt: iso(row.committed_at),
    capturedDurationMs: "captured_duration_ms" in row && row.captured_duration_ms != null ? Number(row.captured_duration_ms) : null,
    captureSessionId, clientReportedCapture: captureSessionId ? await readCaptureClientContext(db, captureSessionId) : null };
}

export async function createSignatureAnchor(db: Database, clock: Clock, userId: string, proofId: string, input: Input) {
  requireFeature("replay");
  await requireSignatureAccess(db, proofId, userId);
  const evidenceId = optionalId(input.evidenceId), eventId = optionalId(input.eventId), stageId = optionalId(input.stageId);
  if (Boolean(evidenceId) === Boolean(eventId) || (stageId && !evidenceId)) fail("INVALID_ANCHOR_SOURCE", "Choose one original recording or event");
  if (!stageId && !(await hasRootSourceAccess(db, proofId, userId)))
    fail("INSUFFICIENT_SCOPE", "Outbound originals and their source details require separate participant or reviewed disclosure access", 403);
  const label = text(input.label, "Chapter label", 120), key = text(input.idempotencyKey, "Idempotency key");
  const supersedesId = optionalId(input.supersedesId);
  const recipeVersion = input.recipeVersion == null ? null : text(input.recipeVersion, "Recipe version", 100);
  if (recipeVersion && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(recipeVersion)) fail("INVALID_RECIPE_VERSION", "Use a bounded recipe version identifier");
  const sourceType = input.sourceType ?? "USER_MARKED";
  if (sourceType !== "USER_MARKED" && sourceType !== "SCANNER_TRIGGERED") fail("INVALID_ANCHOR_SOURCE", "Chapter origin must be user-marked or scanner-triggered");
  if (evidenceId && (typeof input.startMs !== "number" || typeof input.endMs !== "number" ||
      !Number.isInteger(input.startMs) || !Number.isInteger(input.endMs) || input.startMs < 0 || input.endMs <= input.startMs || input.endMs > MAX_RECORDING_MS))
    fail("INVALID_ANCHOR_RANGE", "Use a nonempty elapsed range between 0 and 6 hours");
  if (eventId && (input.startMs != null || input.endMs != null)) fail("INVALID_ANCHOR_RANGE", "Events use their source time, not elapsed video time");
  const requestHash = sha256Hex(canonicalize({ evidenceId, eventId, stageId, label, supersedesId, sourceType, ...(recipeVersion ? { recipeVersion } : {}),
    startMs: input.startMs ?? null, endMs: input.endMs ?? null }));
  return db.transaction(async tx => {
    await loadProof(tx, proofId, true);
    const old = (await tx.query<Stored & { request_sha256: string }>(
      "SELECT * FROM evidence_anchors WHERE proof_id=$1 AND actor_user_id=$2 AND idempotency_key=$3", [proofId, userId, key])).rows[0];
    if (old) {
      if (old.request_sha256 !== requestHash) fail("IDEMPOTENCY_CONFLICT", "This bookmark key was used for another source or range", 409);
      return decode<SignatureAnchor>(old);
    }
    const anchors = await listAnchors(tx, proofId);
    if (anchors.length >= MAX_ANCHORS) fail("SIGNATURE_LIMIT", "Chapter limit reached", 413);
    if (supersedesId && !anchors.some(a => a.anchorId === supersedesId && a.authorUserId === userId))
      fail("ANCHOR_CORRECTION_INVALID", "You may append corrections only to your own chapter in this Proof", 403);
    let startMs: number | null = null, endMs: number | null = null, sourceHash: string;
    let rangeVerification: SignatureAnchor["rangeVerification"] = "NOT_APPLICABLE";
    let captureSessionId: string | null = null;
    if (evidenceId) {
      const media = await sourceMedia(tx, proofId, evidenceId, stageId);
      if (!media.contentType.startsWith("video/")) fail("INVALID_ANCHOR_SOURCE", "Timed chapters require a video source");
      if (typeof input.startMs !== "number" || typeof input.endMs !== "number" ||
        !Number.isInteger(input.startMs) || !Number.isInteger(input.endMs) ||
        input.startMs < 0 || input.endMs <= input.startMs || input.endMs > MAX_RECORDING_MS)
        fail("INVALID_ANCHOR_RANGE", "Use a nonempty elapsed range between 0 and 6 hours");
      startMs = input.startMs; endMs = input.endMs; sourceHash = media.sha256;
      captureSessionId = media.captureSessionId ?? null;
      if (media.capturedDurationMs != null && endMs > media.capturedDurationMs)
        fail("INVALID_ANCHOR_RANGE", "The chapter extends beyond the independently read source duration");
      rangeVerification = media.capturedDurationMs == null ? "DURATION_UNAVAILABLE" : "VERIFIED_SOURCE_DURATION";
    } else {
      const proof = await getCanonicalProof(tx, proofId, userId);
      const event = proof.chronology.find(e => e.id === eventId);
      if (!event) fail("ANCHOR_SOURCE_NOT_FOUND", "Event is not in this Proof", 404);
      if (input.startMs != null || input.endMs != null) fail("INVALID_ANCHOR_RANGE", "Events use their source time, not elapsed video time");
      sourceHash = signatureEvent(proof, event).sourceHash!;
    }
    const anchor: SignatureAnchor = { schema: "packproof.evidence-anchor.v1", anchorId: newId("anchor"), proofId,
      evidenceId, eventId, stageId, sourceHash, sourceVersion: `sha256:${sourceHash}`, captureSessionId, recipeVersion, startMs, endMs, label,
      sourceType, sourceCategory: sourceType === "USER_MARKED" ? "USER_MARKED_OBSERVATION" : "SCANNER_OBSERVATION",
      timeBasis: evidenceId ? "RECORDING_ELAPSED" : "SOURCE_EVENT", rangeVerification, supersedesId,
      authorUserId: userId, createdAt: clock.now().toISOString() };
    const json = canonicalize(anchor);
    await tx.query(`INSERT INTO evidence_anchors(id,proof_id,actor_user_id,payload_json,sha256,idempotency_key,request_sha256,supersedes_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [anchor.anchorId, proofId, userId, json, sha256Hex(json), key, requestHash, supersedesId, anchor.createdAt]);
    await appendAudit(tx, { proofId, actorUserId: userId, eventType: "EVIDENCE_CHAPTER_APPENDED",
      eventData: { anchorId: anchor.anchorId, sourceHash, supersedesId }, at: clock.now() });
    return anchor;
  });
}

export async function createSignatureSnapshot(db: Database, clock: Clock, userId: string, proofId: string): Promise<SignatureSnapshot> {
  await requireSignatureAccess(db, proofId, userId);
  return db.transaction(async tx => {
    // Serialize with Proof commands so source selection is a consistent bounded read.
    await loadProof(tx, proofId, true);
    const proof = await getCanonicalProof(tx, proofId, userId);
    const rootAccess = await hasRootSourceAccess(tx, proofId, userId);
    const rootMedia = rootAccess ? proof.evidence.filter(e => e.validationStatus === "COMMITTED") : [];
    const stageRows = (await tx.query<{ id: string; stage_id: string }>(
      `SELECT e.id,e.stage_id FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id
       WHERE s.proof_id=$1 AND e.committed_at IS NOT NULL AND e.discarded_at IS NULL ORDER BY e.id LIMIT $2`, [proofId, MAX_MEDIA + 1])).rows;
    if (rootMedia.length + stageRows.length > MAX_MEDIA || proof.chronology.length > MAX_EVENTS)
      fail("SIGNATURE_LIMIT", "Use the original viewer for this record; signature source limit exceeded", 413);
    const evidence: SignatureMedia[] = [];
    for (const row of rootMedia) evidence.push(await sourceMedia(tx, proofId, row.evidenceId, null));
    for (const row of stageRows) evidence.push(await sourceMedia(tx, proofId, row.id, row.stage_id));
    const chronology: SignatureEvent[] = rootAccess ? proof.chronology.map(e => signatureEvent(proof, e))
      : proof.chronology.filter(e => e.category === "SHIPMENT" || ["PROOF_CREATED", "PROOF_FINALIZED", "LIFECYCLE_STAGE_FINALIZED"].includes(e.eventType))
        .map(e => ({ eventId: e.id, eventType: e.eventType, occurredAt: e.occurredAt, source: e.source,
          provider: e.provider ?? null, title: e.eventType.toLowerCase().replaceAll("_", " ") }));
    const comparisonRows = rootAccess ? (await tx.query<Stored>("SELECT * FROM signature_comparisons WHERE proof_id=$1 ORDER BY created_at,id LIMIT 301", [proofId])).rows : [];
    if (comparisonRows.length > 300) fail("SIGNATURE_LIMIT", "Comparison observation limit exceeded", 413);
    const observations: SignatureComparisonObservation[] = comparisonRows.map(row => {
      const value = decode<{ comparisonId: string; outbound: SignatureAnchor; inbound: SignatureAnchor; state: string; note: string; supersedesId: string | null; authorUserId: string; createdAt: string }>(row);
      return { comparisonId: value.comparisonId, outboundAnchorId: value.outbound.anchorId, inboundAnchorId: value.inbound.anchorId,
        state: value.state, note: value.note, supersedesId: value.supersedesId, source: "USER_MARKED_OBSERVATION", authorUserId: value.authorUserId, createdAt: value.createdAt };
    });
    const editedFields = new Set(sellerCorrectedFields(proof.transaction.metadata));
    for (const event of proof.events.filter(e => e.eventType === "TRANSACTION_DETAILS_UPDATED")) {
      if (event.data.changed && typeof event.data.changed === "object") for (const field of Object.keys(event.data.changed)) editedFields.add(field);
    }
    const imported = proof.transaction.provenance;
    const sourceOf = (field: string) => !editedFields.has(field) && imported &&
      ((imported.originalSource ?? imported.source).endsWith("_API")) ? "PROVIDER_REPORTED_FIELD" : "PARTICIPANT_SUPPLIED_STATEMENT";
    const fieldSources = Object.fromEntries((rootAccess ? ["itemTitle", "itemDescription", "quantity"] : ["itemTitle"]).map(field => [field, sourceOf(field)]));
    const orderSources = new Set(Object.values(fieldSources));
    const data: SignatureSnapshotData = { schema: "packproof.signature-snapshot.v1", proofId,
      proofVersion: proof.version, manifestSha256: rootAccess ? proof.integrity.manifestSha256 : null, status: proof.status,
      audience: rootAccess ? "PARTICIPANT" : "RECEIVER",
      sourceAccess: { outboundOriginals: rootAccess ? "AVAILABLE" : "WITHHELD_BY_SCOPE", outboundView: rootAccess ? "Participant original access" : "Open an explicitly authorized reviewed disclosure link to inspect shared outbound media. A receipt invitation does not grant original access." },
      order: { itemTitle: proof.transaction.itemTitle, itemDescription: rootAccess ? proof.transaction.itemDescription : null,
        quantity: rootAccess ? proof.transaction.quantity : null, source: orderSources.size === 1 ? [...orderSources][0] : "MIXED_PROVIDER_AND_PARTICIPANT_FIELDS", fieldSources },
      shipping: { carrier: proof.transaction.shipping?.carrier ?? null,
        events: chronology.filter(e => proof.shipmentObservations.events.some(s => s.id === e.eventId)) },
      evidence, statements: rootAccess ? proof.attestations.map(a => ({ attestationId: a.attestationId, statement: a.statement, source: "PARTICIPANT_SUPPLIED_STATEMENT" })) : [],
      anchors: (await listAnchors(tx, proofId)).filter(a => rootAccess || (a.stageId != null && evidence.some(e => e.evidenceId === a.evidenceId && e.stageId === a.stageId))), chronology, observations,
      limitations: ["A snapshot preserves selected record data and source references, not a finding of physical truth.",
        "Recording ranges are user or scanner bookmarks; elapsed time is not independently verified filming time.",
        "Original availability remains subject to the stated retention policy.",
        ...(!rootAccess ? ["Outbound originals, their chapters and hashes, private statements, and detailed order fields are withheld from this receipt view. Inspect only the media explicitly provided through an authorized disclosure link."] : [])] };
    const json = canonicalize(data), hash = sha256Hex(json), id = newId("snapshot"), at = clock.now().toISOString();
    await tx.query("INSERT INTO signature_snapshots(id,proof_id,actor_user_id,payload_json,sha256,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(proof_id,sha256) DO NOTHING", [id, proofId, userId, json, hash, at]);
    const row = (await tx.query<Stored>("SELECT * FROM signature_snapshots WHERE proof_id=$1 AND sha256=$2", [proofId, hash])).rows[0];
    return { snapshotId: row.id, sha256: row.sha256, createdAt: iso(row.created_at), data: decode<SignatureSnapshotData>(row) };
  });
}
export async function getSignatureSnapshot(db: Database, userId: string, proofId: string, snapshotId: string): Promise<SignatureSnapshot> {
  await requireSignatureAccess(db, proofId, userId);
  const row = (await db.query<Stored & { actor_user_id: string }>("SELECT * FROM signature_snapshots WHERE proof_id=$1 AND id=$2", [proofId, snapshotId])).rows[0];
  if (!row) fail("SNAPSHOT_NOT_FOUND", "Snapshot is not available in this Proof", 404);
  if (sha256Hex(row.payload_json) !== row.sha256) fail("SNAPSHOT_INTEGRITY_FAILURE", "Snapshot integrity check failed", 409);
  const data = decode<SignatureSnapshotData>(row);
  if (!(await hasRootSourceAccess(db, proofId, userId)) && (data.audience !== "RECEIVER" || row.actor_user_id !== userId))
    fail("INSUFFICIENT_SCOPE", "This snapshot contains sources outside your receipt access. Open the current recipient view.", 403);
  return { snapshotId: row.id, sha256: row.sha256, createdAt: iso(row.created_at), data };
}
/** A supplied bearer grant authorizes one scoped view; it never upgrades a receipt participant. */
export async function getSignatureOutboundView(db: Database, clock: Clock, userId: string, proofId: string, token: unknown) {
  await requireSignatureAccess(db, proofId, userId);
  const context = await resolveDisclosureContext(db, clock, { proofId, token: text(token, "Shared view token", 300) });
  const projection = await getDisclosureProjection(db, context);
  const current = await resolveDisclosureContext(db, clock, { proofId, token: text(token, "Shared view token", 300) });
  if (current.grantId !== context.grantId || current.scopeVersion !== context.scopeVersion || current.scopeIdentity !== context.scopeIdentity)
    fail("INSUFFICIENT_SCOPE", "The shared view changed; reopen the current disclosure link", 403);
  return { projection, access: "EXPLICIT_DISCLOSURE_GRANT", limitations: [
    "Inspect only the media returned by this grant through its scoped media route. No original-source fallback is authorized.",
    "The grant does not expose a full signature snapshot or authorize unshared outbound anchors, exports, or persisted comparison references."] };
}

/** Deterministic, read-only lookup. User text never executes instructions or changes access. */
export async function askSignatureProof(db: Database, userId: string, proofId: string, input: Input) {
  requireFeature("ask");
  const snapshot = await getSignatureSnapshot(db, userId, proofId, text(input.snapshotId, "Snapshot"));
  const question = text(input.question, "Question", 500), normalized = question.toLowerCase().replace(/[?.!]/g, "").trim();
  const data = snapshot.data, citations: SignatureCitation[] = [];
  let answer = "This record does not establish the answer. Try asking about the order, available recordings, bookmarks, or reported shipping events.";
  // Deliberately bounded intents: no free-form model, inferred condition, liability or authenticity.
  const risky = /authentic|genuine|fraud|fault|liable|liability|refund|win|prove|stole|scam|ignore|instruction|system prompt/.test(normalized);
  if (!risky && /^(what (item|order)|what was (ordered|purchased)|order details|item details)/.test(normalized) && data.order.itemTitle) {
    const titleSource = data.order.fieldSources?.itemTitle ?? data.order.source;
    answer = `The ${titleSource === "PROVIDER_REPORTED_FIELD" ? "provider" : "participant"} supplied item title is “${data.order.itemTitle}”.${data.order.quantity == null ? "" : ` Recorded quantity: ${data.order.quantity}.`}`;
    citations.push({ kind: "FIELD", id: "order.itemTitle", source: titleSource, label: "Recorded order title" });
    if (data.order.quantity != null) citations.push({ kind: "FIELD", id: "order.quantity", source: data.order.fieldSources?.quantity ?? data.order.source, label: "Recorded quantity" });
  } else if (!risky && /^(what|which|show|list|where).*(recording|video|evidence)/.test(normalized) && data.evidence.length) {
    answer = `${data.evidence.length} committed media source${data.evidence.length === 1 ? " is" : "s are"} included in this snapshot. Open a source to inspect the original.`;
    citations.push(...data.evidence.map(e => ({ kind: "MEDIA" as const, id: e.evidenceId, source: "PACKPROOF_RECEIPT_INTEGRITY_EVENT", label: `${e.stageType ?? "Outbound"}: ${e.contentType}` })));
  } else if (!risky && /^(where|show|find|which).*(serial|identifier|label|packing|box|item|bookmark|chapter)/.test(normalized)) {
    const term = /serial|identifier/.test(normalized) ? /serial|identifier/i : /label/.test(normalized) ? /label/i : /box/.test(normalized) ? /box|seal/i : /packing/.test(normalized) ? /pack/i : /item/.test(normalized) ? /item/i : /./;
    const superseded = new Set(data.anchors.map(a => a.supersedesId).filter(Boolean));
    const anchors = data.anchors.filter(a => !superseded.has(a.anchorId) && term.test(a.label));
    if (anchors.length) {
      answer = "These marked chapters may help locate the requested view. Their labels are observations; inspect the original to confirm what is visible.";
      citations.push(...anchors.map(a => ({ kind: "ANCHOR" as const, id: a.anchorId, source: a.sourceCategory, label: a.label })));
    }
  } else if (!risky && /^(what|show|list|when).*(carrier|shipping|shipment|dispatch|delivery|delivered|timeline|chronology)/.test(normalized)) {
    const events = /timeline|chronology/.test(normalized) ? data.chronology : data.shipping.events;
    if (events.length) {
      answer = "The snapshot contains these source-reported events. A delivery scan is a carrier report; it is not buyer testimony or confirmation of contents.";
      citations.push(...events.map(e => ({ kind: "EVENT" as const, id: e.eventId, source: e.source, label: `${e.title} · ${e.occurredAt}` })));
    }
  }
  return { schema: "packproof.structured-answer.v1", snapshotId: snapshot.snapshotId, snapshotSha256: snapshot.sha256,
    state: citations.length ? "SUPPORTED" as const : "NOT_ESTABLISHED" as const, answer, citations,
    assistance: true, ruleVersion: "structured-lookup.v1", model: null, usage: { modelTokens: 0, sourceCount: citations.length } };
}

function caseScope(value: unknown, data: SignatureSnapshotData): CaseScope {
  if (value == null) return { fields: [...FIELDS], evidenceIds: data.evidence.map(e => e.evidenceId) };
  if (typeof value !== "object" || Array.isArray(value)) fail("INVALID_DISCLOSURE_SCOPE", "Choose packet fields and sources");
  const scope = value as Input;
  if (!Array.isArray(scope.fields) || scope.fields.some(f => typeof f !== "string" || !(FIELDS as readonly string[]).includes(f)) ||
      !Array.isArray(scope.evidenceIds) || scope.evidenceIds.length > MAX_MEDIA ||
      scope.evidenceIds.some(id => typeof id !== "string" || !data.evidence.some(e => e.evidenceId === id)))
    fail("INVALID_DISCLOSURE_SCOPE", "Packet scope includes an unavailable field or media source");
  if (!scope.fields.includes("evidence") && scope.evidenceIds.length) fail("INVALID_DISCLOSURE_SCOPE", "Enable evidence before selecting sources");
  return { fields: [...new Set(scope.fields as string[])].sort(), evidenceIds: [...new Set(scope.evidenceIds as string[])].sort() };
}
export async function buildSignatureCase(db: Database, clock: Clock, userId: string, proofId: string, input: Input) {
  requireFeature("cases");
  const snapshot = await getSignatureSnapshot(db, userId, proofId, text(input.snapshotId, "Snapshot"));
  if (typeof input.template !== "string" || !Object.hasOwn(CASE_TEMPLATES, input.template)) fail("INVALID_CASE_TEMPLATE", "Choose one of the three supported issue templates");
  const template = input.template as CaseTemplate, descriptor = CASE_TEMPLATES[template], data = snapshot.data;
  const scope = caseScope(input.scope, data), includes = (field: string) => scope.fields.includes(field);
  const evidence = includes("evidence") ? data.evidence.filter(e => scope.evidenceIds.includes(e.evidenceId)) : [];
  const selected = new Set(evidence.map(e => e.evidenceId));
  const anchors = data.anchors.filter(a => a.evidenceId && selected.has(a.evidenceId) && descriptor.terms.test(a.label));
  const authorizedAnchorIds = new Set(data.anchors.filter(a => a.evidenceId && selected.has(a.evidenceId)).map(a => a.anchorId));
  const observations = includes("statements") ? (data.observations ?? []).filter(o => authorizedAnchorIds.has(o.outboundAnchorId) && authorizedAnchorIds.has(o.inboundAnchorId)) : [];
  const notes = text(input.notes, "Factual notes", 4000, true);
  const gaps = ["The record does not independently establish contents at every point after packing.", "An allegation is not a finding of fault."];
  if (data.status !== "FINALIZED") gaps.push("The core Proof was not finalized in this snapshot.");
  else if (!data.manifestSha256) gaps.push("The core manifest digest is withheld by this recipient scope.");
  if (!evidence.length) gaps.push(includes("evidence") ? "No committed media was selected." : "Media was withheld from this packet.");
  if (!anchors.length) gaps.push("No issue-specific bookmarked moment was available among the selected sources; inspect surrounding footage.");
  if (!includes("shipping")) gaps.push("Shipping information was withheld from this packet.");
  else if (!data.shipping.events.length) gaps.push("No carrier event was included in this snapshot.");
  if (template === "CONDITION_RETURN" && !evidence.some(e => e.stageType === "RETURN_RECEIPT" || e.stageType === "RETURN_PACKING")) gaps.push("Selected evidence does not include a committed return recording; a before/after comparison is not established.");
  if (observations.length < (data.observations?.length ?? 0)) gaps.push("One or more recorded comparison observations are withheld by the selected statement or media scope; this packet is incomplete for comparison review.");
  const preview: SignatureCasePreview = { schema: "packproof.case-packet.v1", proofId, template, templateVersion: "1",
    title: descriptor.title, summary: `This packet organizes the selected record for review of ${descriptor.title.toLowerCase()}. It makes no finding about authenticity, fault, liability, or the outcome of a claim.`,
    snapshotId: snapshot.snapshotId, snapshotSha256: snapshot.sha256, coreManifestSha256: data.manifestSha256,
    scope, status: includes("status") ? data.status : null, order: includes("order") ? data.order : null,
    shipping: includes("shipping") ? data.shipping : null, evidence, anchors,
    statements: includes("statements") ? data.statements : [], observations, notes: notes ? { text: notes, source: "USER_SUPPLIED_NOTE" } : null,
    gaps, limitations: [...data.limitations, "Only the explicitly selected fields and sources are included. Other evidence or contrary observations may exist outside this packet.",
      "Included media references require separate authorized original access; this artifact does not grant access or contain original bytes."] };
  const json = canonicalize(preview), hash = sha256Hex(json), id = newId("case");
  await db.transaction(async tx => {
    await tx.query("INSERT INTO signature_cases(id,proof_id,snapshot_id,actor_user_id,payload_json,sha256,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [id, proofId, snapshot.snapshotId, userId, json, hash, clock.now().toISOString()]);
    await appendAudit(tx, { proofId, actorUserId: userId, eventType: "CASE_PACKET_PREVIEWED", eventData: { caseId: id, snapshotId: snapshot.snapshotId, previewSha256: hash, template }, at: clock.now() });
  });
  return { caseId: id, sha256: hash, preview, approved: false };
}
export async function getSignatureCase(db: Database, userId: string, proofId: string, caseId: string) {
  await requireSignatureAccess(db, proofId, userId);
  const row = (await db.query<Stored & { actor_user_id: string; snapshot_id: string }>("SELECT * FROM signature_cases WHERE proof_id=$1 AND id=$2", [proofId, caseId])).rows[0];
  if (!row) fail("CASE_NOT_FOUND", "Packet is not available in this Proof", 404);
  if (sha256Hex(row.payload_json) !== row.sha256) fail("CASE_INTEGRITY_FAILURE", "Packet integrity check failed", 409);
  await getSignatureSnapshot(db, userId, proofId, row.snapshot_id);
  const approval = (await db.query<{ actor_user_id: string; approved_at: string | Date; preview_sha256: string }>("SELECT * FROM signature_case_approvals WHERE case_id=$1", [caseId])).rows[0];
  return { caseId, sha256: row.sha256, preview: decode<SignatureCasePreview>(row), createdBy: row.actor_user_id,
    approved: Boolean(approval), approval: approval ? { actorUserId: approval.actor_user_id, approvedAt: iso(approval.approved_at), previewSha256: approval.preview_sha256 } : null };
}
export async function approveSignatureCase(db: Database, clock: Clock, userId: string, proofId: string, caseId: string, previewSha256: unknown) {
  requireFeature("cases");
  const packet = await getSignatureCase(db, userId, proofId, caseId);
  if (packet.createdBy !== userId) fail("CASE_APPROVER_REQUIRED", "The packet creator must approve its exact recipient preview", 403);
  if (previewSha256 !== packet.sha256) fail("CASE_PREVIEW_CHANGED", "Review and approve the exact packet hash", 409);
  await db.transaction(async tx => {
    const result = await tx.query("INSERT INTO signature_case_approvals(case_id,actor_user_id,preview_sha256,approved_at) VALUES($1,$2,$3,$4) ON CONFLICT(case_id) DO NOTHING RETURNING case_id", [caseId, userId, packet.sha256, clock.now().toISOString()]);
    if (result.rowCount) await appendAudit(tx, { proofId, actorUserId: userId, eventType: "CASE_PACKET_APPROVED", eventData: { caseId, previewSha256 }, at: clock.now() });
  });
  return getSignatureCase(db, userId, proofId, caseId);
}
export function renderSignatureCaseHtml(preview: SignatureCasePreview, previewSha256: string, approver: string, webBaseUrl = "https://thepackproof.com") {
  const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  const base = new URL(webBaseUrl);
  if (!["https:", "http:"].includes(base.protocol)) fail("INVALID_WEB_ORIGIN", "A trusted HTTP web origin is required for source links", 500);
  const sourceLink = (kind: "anchor" | "evidence", id: string) => `${base.origin}/proofs/${encodeURIComponent(preview.proofId)}?${kind}=${encodeURIComponent(id)}&snapshot=${encodeURIComponent(preview.snapshotId)}`;
  const list = (items: string[]) => `<ul>${items.map(item => `<li>${esc(item)}</li>`).join("")}</ul>`;
  const sourceTable = `<table><thead><tr><th>Source</th><th>Recorded metadata</th><th>SHA-256</th></tr></thead><tbody>${preview.evidence.map(e =>
    `<tr><td><a href="${esc(sourceLink("evidence", e.evidenceId))}" rel="noreferrer">${esc(e.evidenceId)}</a><br>${esc(e.stageType ?? "Outbound original")}</td><td>${esc(e.contentType)}<br>${esc(e.committedAt)}<br>${esc(e.byteSize)} bytes</td><td class="hash">${esc(e.sha256)}</td></tr>`).join("")}</tbody></table>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>PackProof · ${esc(preview.title)}</title><style>
    body{font:15px/1.6 system-ui,sans-serif;color:#14283e;background:#fff;margin:0}main{max-width:920px;margin:40px auto;padding:0 32px}header{border-top:6px solid #2588d5;border-bottom:1px solid #dbe4ec;padding:24px 0}.brand{font-weight:800;color:#1766ac;letter-spacing:.05em}h1{font-size:30px;line-height:1.2}h2{font-size:20px;margin-top:30px;color:#125b90}table{border-collapse:collapse;width:100%;table-layout:fixed}td,th{padding:10px;border:1px solid #dbe4ec;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#f2f7fb}.hash{font:12px/1.5 monospace;overflow-wrap:anywhere}.source{color:#496579;font-size:13px}blockquote{margin:12px 0;padding:12px 18px;border-left:3px solid #32a58b;background:#f4faf8;white-space:pre-wrap}.meta{overflow-wrap:anywhere;font-size:12px;color:#496579}@media print{main{margin:0;padding:0}h2,tr,blockquote{break-inside:avoid}body{font-size:11pt}}
    </style></head><body><main><header><div class="brand">PACKPROOF / CASE PACKET</div><h1>${esc(preview.title)}</h1><p>${esc(preview.summary)}</p><div class="meta">Proof ${esc(preview.proofId)} · Template ${esc(preview.templateVersion)}<br>Snapshot ${esc(preview.snapshotId)}<br>Snapshot SHA-256 ${esc(preview.snapshotSha256)}<br>Approved preview SHA-256 ${esc(previewSha256)}<br>Approved by ${esc(approver)}</div></header>
    ${preview.order ? `<h2>Order context</h2><p><strong>${esc(preview.order.itemTitle ?? "Item not recorded")}</strong><br>Quantity: ${esc(preview.order.quantity ?? "Not recorded")}</p><blockquote>${esc(preview.order.itemDescription ?? "No description recorded")}</blockquote><p class="source">Source: ${esc(preview.order.source)} · order.itemTitle / order.quantity / order.itemDescription</p>` : ""}
    ${preview.shipping ? `<h2>Reported shipping events</h2>${list(preview.shipping.events.map(e => `${e.occurredAt} · ${e.title} · Source: ${e.source}${e.provider ? ` / ${e.provider}` : ""} · Event ${e.eventId}`))}` : ""}
    <h2>Evidence index</h2>${sourceTable}<p class="source">Original bytes are referenced, not embedded. Authorized original access is required.</p>
    <h2>Marked moments</h2><ul>${preview.anchors.map(a => `<li><a href="${esc(sourceLink("anchor", a.anchorId))}" rel="noreferrer">${esc(a.label)}</a> · ${esc(a.evidenceId)} · ${esc(a.startMs)}–${esc(a.endMs)} ms in the original · ${esc(a.sourceCategory)} · ${esc(a.anchorId)}</li>`).join("")}</ul><p class="source">Source links require existing authorization and never contain an access token.</p>
    ${preview.statements.length ? `<h2>Participant statements</h2>${list(preview.statements.map(s => `${s.statement} · Source: ${s.source} · ${s.attestationId}`))}` : ""}
    ${preview.observations?.length ? `<h2>Comparison observations and corrections</h2>${list(preview.observations.map(o => `${o.state}: ${o.note} · ${o.source} · ${o.comparisonId}${o.supersedesId ? ` · Corrects ${o.supersedesId}` : ""} · Sources ${o.outboundAnchorId} / ${o.inboundAnchorId}`))}` : ""}
    ${preview.notes ? `<h2>Factual notes supplied for review</h2><blockquote>${esc(preview.notes.text)}</blockquote><p class="source">${esc(preview.notes.source)}</p>` : ""}
    <h2>Gaps and limits</h2>${list(preview.gaps)}${list(preview.limitations)}<footer class="meta">This packet contains the exact approved snapshot selection. It does not submit a claim or grant additional access.</footer></main></body></html>`;
}
export async function exportSignatureCase(db: Database, clock: Clock, userId: string, proofId: string, caseId: string, format: "json" | "html" = "json", webBaseUrl?: string) {
  requireFeature("cases");
  const packet = await getSignatureCase(db, userId, proofId, caseId);
  if (!packet.approved) fail("CASE_APPROVAL_REQUIRED", "Preview and approve the packet before exporting", 409);
  const bytes = Buffer.from(format === "html" ? renderSignatureCaseHtml(packet.preview, packet.sha256, packet.approval!.actorUserId, webBaseUrl)
    : canonicalize({ schema: "packproof.approved-case-export.v1", caseId, previewSha256: packet.sha256,
      approval: packet.approval, packet: packet.preview }));
  const artifactSha256 = sha256Hex(bytes);
  await appendAudit(db, { proofId, actorUserId: userId, eventType: "CASE_PACKET_EXPORTED", eventData: { caseId, artifactSha256, previewSha256: packet.sha256, format }, at: clock.now() });
  return { bytes, artifactSha256 };
}

export async function appendSignatureComparison(db: Database, clock: Clock, userId: string, proofId: string, input: Input) {
  requireFeature("compare");
  await requireParticipant(db, proofId, userId);
  const snapshot = await getSignatureSnapshot(db, userId, proofId, text(input.snapshotId, "Snapshot"));
  const outbound = snapshot.data.anchors.find(a => a.anchorId === input.outboundAnchorId);
  const inbound = snapshot.data.anchors.find(a => a.anchorId === input.inboundAnchorId);
  if (!outbound?.evidenceId || !inbound?.evidenceId || outbound.stageId || !inbound.stageId || outbound.evidenceId === inbound.evidenceId)
    fail("INVALID_COMPARISON_PAIR", "Pair a committed outbound chapter with a receipt or return chapter in this snapshot");
  await sourceMedia(db, proofId, outbound.evidenceId, null);
  await sourceMedia(db, proofId, inbound.evidenceId, inbound.stageId);
  const state = input.state;
  if (state !== "OBSERVED_DIFFERENCE" && state !== "NO_VISIBLE_DIFFERENCE" && state !== "NOT_COMPARABLE") fail("INVALID_COMPARISON_STATE", "Choose an observation or not comparable");
  const assetId = optionalId(input.assetId), supersedesId = optionalId(input.supersedesId);
  if (assetId && !(await db.query("SELECT 1 FROM proof_assets WHERE id=$1 AND proof_id=$2", [assetId, proofId])).rows[0]) fail("ASSET_NOT_FOUND", "Asset is not in this Proof", 404);
  if (supersedesId && !(await db.query("SELECT 1 FROM signature_comparisons WHERE id=$1 AND proof_id=$2 AND actor_user_id=$3", [supersedesId, proofId, userId])).rows[0]) fail("COMPARISON_CORRECTION_INVALID", "Append corrections only to your own observation in this Proof", 403);
  const note = text(input.note, "Observation", 2000);
  const payload = { schema: "packproof.return-comparison.v1", comparisonId: newId("comparison"), proofId, snapshotId: snapshot.snapshotId,
    snapshotSha256: snapshot.sha256, outbound, inbound, assetId, state, note, supersedesId,
    sourceCategory: "USER_MARKED_OBSERVATION", authorUserId: userId, createdAt: clock.now().toISOString(),
    alignment: "MANUAL_PAIRING", limitations: ["Lighting, angle, glare, wrapping, compression or missing views can prevent comparison.",
      "A matching identifier is not authentication. An observed difference is not a finding of fraud or liability.",
      "Each elapsed time belongs to its own original; paired playback is a presentation aid."] };
  const json = canonicalize(payload), hash = sha256Hex(json);
  await db.transaction(async tx => {
    await tx.query(`INSERT INTO signature_comparisons(id,proof_id,snapshot_id,actor_user_id,outbound_anchor_id,inbound_anchor_id,payload_json,sha256,supersedes_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [payload.comparisonId, proofId, snapshot.snapshotId, userId, outbound.anchorId, inbound.anchorId, json, hash, supersedesId, payload.createdAt]);
    await appendAudit(tx, { proofId, actorUserId: userId, eventType: "RETURN_COMPARISON_APPENDED", eventData: { comparisonId: payload.comparisonId, supersedesId }, at: clock.now() });
  });
  return { ...payload, sha256: hash };
}
export async function listSignatureComparisons(db: Database, userId: string, proofId: string) {
  await requireSignatureAccess(db, proofId, userId);
  if (!(await hasRootSourceAccess(db, proofId, userId))) return [];
  const rows = await db.query<Stored>("SELECT * FROM signature_comparisons WHERE proof_id=$1 ORDER BY created_at,id LIMIT 300", [proofId]);
  return rows.rows.map(row => ({ ...decode<Record<string, unknown>>(row), sha256: row.sha256 }));
}

async function optedIn(db: Database, proofId: string) {
  return Boolean((await db.query<{ opted_in: boolean }>("SELECT opted_in FROM item_history_consents WHERE proof_id=$1 ORDER BY consent_sequence DESC LIMIT 1", [proofId])).rows[0]?.opted_in);
}
export async function setItemHistoryConsent(db: Database, clock: Clock, userId: string, proofId: string, optIn: unknown) {
  // Consent withdrawal remains available even when the optional history feature is disabled.
  if (optIn !== false) requireFeature("history");
  await requireParticipant(db, proofId, userId, "SELLER");
  if (typeof optIn !== "boolean") fail("INVALID_HISTORY_CONSENT", "Explicitly choose whether to share this Proof in an item history");
  await db.transaction(async tx => {
    await tx.query("SELECT id FROM item_history_graph_lock WHERE id=1 FOR UPDATE");
    await tx.query("INSERT INTO item_history_consents(id,proof_id,actor_user_id,opted_in,created_at) VALUES($1,$2,$3,$4,$5)", [newId("consent"), proofId, userId, optIn, clock.now().toISOString()]);
    await appendAudit(tx, { proofId, actorUserId: userId, eventType: "ITEM_HISTORY_CONSENT_RECORDED", eventData: { optedIn: optIn }, at: clock.now() });
  });
  return { proofId, optedIn: optIn };
}
export async function linkItemHistory(db: Database, clock: Clock, userId: string, proofId: string, input: Input) {
  requireFeature("history");
  const previousProofId = text(input.previousProofId, "Previous Proof"), previousAssetId = text(input.previousAssetId, "Previous asset"), assetId = text(input.assetId, "Current asset");
  await requireParticipant(db, proofId, userId); await requireParticipant(db, previousProofId, userId);
  if (proofId === previousProofId) fail("INVALID_HISTORY_LINK", "A history connects separate transaction Proofs");
  const note = text(input.note, "Link basis", 2000);
  return db.transaction(async tx => {
    // One small opt-in pilot graph; serialize changes so concurrent additions cannot create a cycle.
    await tx.query("SELECT id FROM item_history_graph_lock WHERE id=1 FOR UPDATE");
    if (!(await optedIn(tx, proofId)) || !(await optedIn(tx, previousProofId))) fail("HISTORY_CONSENT_REQUIRED", "Both source Proofs must independently opt in", 403);
    const assets = await tx.query<{ id: string; proof_id: string }>("SELECT id,proof_id FROM proof_assets WHERE id=ANY($1::text[])", [[assetId, previousAssetId]]);
    if (!assets.rows.some(a => a.id === assetId && a.proof_id === proofId) || !assets.rows.some(a => a.id === previousAssetId && a.proof_id === previousProofId)) fail("INVALID_HISTORY_ASSET", "Each asset must belong to its referenced Proof");
    const cycle = await tx.query(`WITH RECURSIVE reachable(id) AS (SELECT proof_id FROM item_history_links WHERE previous_proof_id=$1
      UNION SELECT h.proof_id FROM item_history_links h JOIN reachable r ON h.previous_proof_id=r.id) SELECT 1 FROM reachable WHERE id=$2 LIMIT 1`, [proofId, previousProofId]);
    if (cycle.rows[0]) fail("HISTORY_CYCLE", "This link would create a cyclic history", 409);
    const id = newId("history"), at = clock.now().toISOString();
    const result = await tx.query<{ id: string }>(`INSERT INTO item_history_links(id,previous_proof_id,proof_id,previous_asset_id,asset_id,actor_user_id,note,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(previous_proof_id,proof_id,previous_asset_id,asset_id) DO NOTHING RETURNING id`, [id, previousProofId, proofId, previousAssetId, assetId, userId, note, at]);
    const linkId = result.rows[0]?.id ?? (await tx.query<{ id: string }>("SELECT id FROM item_history_links WHERE previous_proof_id=$1 AND proof_id=$2 AND previous_asset_id=$3 AND asset_id=$4", [previousProofId, proofId, previousAssetId, assetId])).rows[0].id;
    if (result.rowCount) await appendAudit(tx, { proofId, actorUserId: userId, eventType: "ITEM_HISTORY_LINK_ASSERTED", eventData: { linkId }, at: clock.now() });
    return { linkId, state: "ASSERTED", source: "PARTICIPANT_SUPPLIED_STATEMENT" };
  });
}
type HistoryLinkRow = { id: string; previous_proof_id: string; proof_id: string; previous_asset_id: string; asset_id: string; actor_user_id: string; note: string; created_at: string | Date };
export async function appendItemHistoryEvent(db: Database, clock: Clock, userId: string, proofId: string, linkId: string, input: Input) {
  requireFeature("history");
  await requireSignatureAccess(db, proofId, userId);
  const link = (await db.query<HistoryLinkRow>("SELECT * FROM item_history_links WHERE id=$1 AND (proof_id=$2 OR previous_proof_id=$2)", [linkId, proofId])).rows[0];
  if (!link) fail("HISTORY_LINK_NOT_FOUND", "History entry not found", 404);
  await requireParticipant(db, link.proof_id, userId); await requireParticipant(db, link.previous_proof_id, userId);
  if (!(await optedIn(db, link.proof_id)) || !(await optedIn(db, link.previous_proof_id)))
    fail("HISTORY_CONSENT_REQUIRED", "This history entry is unavailable because a source withdrew consent", 403);
  const state = input.state;
  if (state !== "CORROBORATED" && state !== "DISPUTED" && state !== "CORRECTED") fail("INVALID_HISTORY_STATE", "Choose corroborated, disputed or corrected");
  if (state === "CORROBORATED" && link.actor_user_id === userId) fail("HISTORY_SECOND_PARTICIPANT_REQUIRED", "A different authorized participant must corroborate the assertion", 403);
  const id = newId("historyevent"), note = text(input.note, "History observation", 2000), at = clock.now().toISOString();
  await db.transaction(async tx => {
    await tx.query("INSERT INTO item_history_events(id,link_id,actor_user_id,state,note,created_at) VALUES($1,$2,$3,$4,$5,$6)", [id, linkId, userId, state, note, at]);
    await appendAudit(tx, { proofId, actorUserId: userId, eventType: "ITEM_HISTORY_OBSERVATION_APPENDED", eventData: { linkId, historyEventId: id, state }, at: clock.now() });
  });
  return { eventId: id, linkId, state, note, authorUserId: userId, createdAt: at };
}
export async function getItemHistory(db: Database, userId: string, proofId: string) {
  await requireSignatureAccess(db, proofId, userId);
  if (!(await hasRootSourceAccess(db, proofId, userId))) return { optedIn: false, entries: [], partial: true,
    limitations: ["Item history requires independent participant access to each source. A receipt invitation does not share previous transactions."] };
  const consent = await optedIn(db, proofId);
  const entries: Array<Record<string, unknown>> = [];
  if (consent) {
    const links = await db.query<HistoryLinkRow>("SELECT * FROM item_history_links WHERE proof_id=$1 OR previous_proof_id=$1 ORDER BY created_at,id LIMIT 100", [proofId]);
    for (const link of links.rows) {
      const other = link.proof_id === proofId ? link.previous_proof_id : link.proof_id;
      let available = await optedIn(db, other);
      if (available) try { await requireParticipant(db, other, userId); } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        available = false;
      }
      if (!available) { entries.push({ linkId: link.id, state: "UNAVAILABLE", reason: "Entry is outside current authorization or consent; no source details are disclosed." }); continue; }
      const events = (await db.query<{ id: string; state: string; note: string; actor_user_id: string; created_at: string | Date }>("SELECT * FROM item_history_events WHERE link_id=$1 ORDER BY created_at,id", [link.id])).rows;
      const disputed = events.some(e => e.state === "DISPUTED");
      entries.push({ linkId: link.id, previousProofId: link.previous_proof_id, proofId: link.proof_id,
        previousAssetId: link.previous_asset_id, assetId: link.asset_id, assertedBy: link.actor_user_id,
        note: link.note, createdAt: iso(link.created_at), state: disputed ? "DISPUTED" : events.some(e => e.state === "CORROBORATED") ? "CORROBORATED" : "ASSERTED",
        correctionsPresent: events.some(e => e.state === "CORRECTED"), events: events.map(e => ({ eventId: e.id, state: e.state, note: e.note, authorUserId: e.actor_user_id, createdAt: iso(e.created_at) })) });
    }
  }
  return { optedIn: consent, entries, partial: true, limitations: ["Every source requires its own current authorization and consent.",
    "History may have missing intervals. Copied identifiers do not establish authenticity, ownership or uninterrupted custody.", "Disputes and corrections append to the assertion and never erase transaction evidence."] };
}

function historySelection(input: Input) {
  const recipientUserId = text(input.recipientUserId, "Recipient user ID");
  if (!Array.isArray(input.linkIds) || !input.linkIds.length || input.linkIds.length > 25 ||
    input.linkIds.some(id => typeof id !== "string" || !id.trim() || id.length > 200))
    fail("INVALID_HISTORY_SELECTION", "Select 1–25 history entries for this recipient");
  return { recipientUserId, linkIds: [...new Set(input.linkIds as string[])].sort() };
}
async function historyRecipientProjection(db: Database, proofId: string, recipientUserId: string, linkIds: string[]) {
  await requireParticipant(db, proofId, recipientUserId);
  const history = await getItemHistory(db, recipientUserId, proofId);
  const entries = linkIds.map(linkId => history.entries.find(entry => entry.linkId === linkId) ??
    { linkId, state: "UNAVAILABLE", reason: "This selected source is outside current consent or authorization." });
  return { schema: "packproof.selected-item-history.v1", proofId, recipientUserId, linkIds, entries,
    limitations: [...history.limitations, "Only these selected entries are shared; no source access is granted by this handoff.", "Consent withdrawal, source access changes or later observations may change the visible view."] };
}
export async function previewItemHistoryShare(db: Database, userId: string, proofId: string, input: Input) {
  requireFeature("history");
  await requireParticipant(db, proofId, userId);
  const { recipientUserId, linkIds } = historySelection(input);
  const senderView = await getItemHistory(db, userId, proofId);
  if (linkIds.some(id => !senderView.entries.some(entry => entry.linkId === id && entry.state !== "UNAVAILABLE")))
    fail("HISTORY_SELECTION_UNAVAILABLE", "Choose only currently authorized, opted-in history entries", 403);
  const preview = await historyRecipientProjection(db, proofId, recipientUserId, linkIds);
  if (preview.entries.some(entry => entry.state === "UNAVAILABLE"))
    fail("HISTORY_RECIPIENT_ACCESS_REQUIRED", "The recipient must independently have participant access and current consent for every selected source", 403);
  return { preview, previewSha256: sha256Hex(canonicalize(preview)) };
}
export async function createItemHistoryShare(db: Database, clock: Clock, userId: string, proofId: string, input: Input) {
  return db.transaction(async tx => {
    await tx.query("SELECT id FROM item_history_graph_lock WHERE id=1 FOR UPDATE");
    const reviewed = await previewItemHistoryShare(tx, userId, proofId, input);
    if (input.previewSha256 !== reviewed.previewSha256) fail("HISTORY_PREVIEW_CHANGED", "Review the exact selected recipient view before sharing", 409);
    const id = newId("historyshare");
    await tx.query("INSERT INTO item_history_shares(id,proof_id,actor_user_id,recipient_user_id,link_ids,approved_preview_sha256,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)",
      [id, proofId, userId, reviewed.preview.recipientUserId, JSON.stringify(reviewed.preview.linkIds), reviewed.previewSha256, clock.now().toISOString()]);
    await appendAudit(tx, { proofId, actorUserId: userId, eventType: "ITEM_HISTORY_SELECTION_SHARED", eventData: { shareId: id, previewSha256: reviewed.previewSha256 }, at: clock.now() });
    return { shareId: id, proofId, recipientUserId: reviewed.preview.recipientUserId, previewSha256: reviewed.previewSha256,
      path: `/proofs/${encodeURIComponent(proofId)}?historyShare=${encodeURIComponent(id)}` };
  });
}
interface HistoryShareRow { id: string; proof_id: string; actor_user_id: string; recipient_user_id: string; link_ids: string[]; approved_preview_sha256: string }
export async function getItemHistoryShare(db: Database, userId: string, proofId: string, shareId: string) {
  await requireParticipant(db, proofId, userId);
  const share = (await db.query<HistoryShareRow>("SELECT * FROM item_history_shares WHERE id=$1 AND proof_id=$2", [shareId, proofId])).rows[0];
  if (!share || (share.actor_user_id !== userId && share.recipient_user_id !== userId)) fail("HISTORY_SHARE_NOT_FOUND", "Selected history is unavailable for this account", 404);
  if ((await db.query("SELECT 1 FROM item_history_share_revocations WHERE share_id=$1", [shareId])).rows[0]) fail("HISTORY_SHARE_REVOKED", "This history handoff was revoked", 404);
  const preview = await historyRecipientProjection(db, proofId, share.recipient_user_id, share.link_ids);
  // The sender's current view also bounds a selected handoff; retained selection cannot extend withdrawn source access.
  const senderView = await getItemHistory(db, share.actor_user_id, proofId);
  preview.entries = preview.entries.map(entry => senderView.entries.some(allowed => allowed.linkId === entry.linkId && allowed.state !== "UNAVAILABLE") ? entry
    : { linkId: entry.linkId, state: "UNAVAILABLE", reason: "This selected source is outside the sender's current consent or authorization." });
  const currentPreviewSha256 = sha256Hex(canonicalize(preview));
  return { shareId, approvedPreviewSha256: share.approved_preview_sha256, currentPreviewSha256,
    changedSinceApproval: currentPreviewSha256 !== share.approved_preview_sha256, preview };
}
export async function revokeItemHistoryShare(db: Database, clock: Clock, userId: string, proofId: string, shareId: string) {
  await requireParticipant(db, proofId, userId);
  if (!(await db.query("SELECT 1 FROM item_history_shares WHERE id=$1 AND proof_id=$2 AND actor_user_id=$3", [shareId, proofId, userId])).rows[0])
    fail("HISTORY_SHARE_NOT_FOUND", "Only the handoff creator can revoke this selection", 404);
  await db.query("INSERT INTO item_history_share_revocations(share_id,actor_user_id,created_at) VALUES($1,$2,$3) ON CONFLICT(share_id) DO NOTHING", [shareId, userId, clock.now().toISOString()]);
  return { shareId, revoked: true };
}
