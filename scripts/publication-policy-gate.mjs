#!/usr/bin/env node
/** W12-B: mechanical publication gate. Operator-pinned records supply approval;
 * this program does not author legal terms, certify compliance, or approve them. */
import { createHash, randomUUID } from "node:crypto";
import { open, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DAY = 86_400_000;
const MAX_BYTES = 2 * 1024 * 1024;
const KINDS = ["terms", "privacy", "support"];
const PLACEHOLDERS = /\b(?:TODO|TBD|FIXME|PLACEHOLDER|lorem\s+ipsum|coming\s+soon|your\s+(?:company|business|legal\s+entity|address|email)|insert\s+(?:company|business|legal|address|email|contact))\b|\[(?:company|business|legal\s+entity|address|email|contact|insert)[^\]]*\]|\[[^[\]]+—\s*developer\s+review\]|\b(?:example\.(?:com|org|net)|[a-z0-9.-]+\.(?:invalid|test|localhost))\b/i;
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
export function canonicalSha256(value) { return sha256(canonicalize(value)); }
function reject(code) { throw new Error(code); }
function object(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) reject(code);
  return value;
}
function text(value, code, { min = 1, max = 1000 } = {}) {
  if (typeof value !== "string" || value.trim() !== value || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || PLACEHOLDERS.test(value)) reject(code);
  return value;
}
function id(value, code) { text(value, code, { max: 200 }); if (!ID.test(value)) reject(code); return value; }
function digest(value, code) { if (typeof value !== "string" || !HEX.test(value)) reject(code); return value; }
function timestamp(value, code) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) reject(code);
  return Date.parse(value);
}
function publicUrl(value, code) {
  text(value, code, { max: 2000 }); let url;
  try { url = new URL(value); } catch { reject(code); }
  // Published policy pages must use public DNS names, HTTPS and no credentials.
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)
    || /(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion)$/.test(url.hostname)
    || /(?:^|\.)example\.(?:com|org|net)$/.test(url.hostname)) reject(code);
  return url;
}
function email(value, code) {
  text(value, code, { max: 254 });
  if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+$/.test(value)) reject(code);
  publicUrl(`https://${value.split("@")[1]}/`, code); return value;
}
async function bytesAt(root, path) {
  if (typeof path !== "string" || !path || isAbsolute(path)) reject("PUBLICATION_EVIDENCE_PATH_INVALID");
  const candidate = await realpath(resolve(root, path)); const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) reject("PUBLICATION_EVIDENCE_PATH_INVALID");
  return boundedRead(candidate);
}
async function boundedRead(path) {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) reject("PUBLICATION_EVIDENCE_SIZE_INVALID");
    const bytes = Buffer.alloc(MAX_BYTES + 1); let size = 0;
    while (size < bytes.length) { const chunk = await handle.read(bytes, size, bytes.length - size, null); if (chunk.bytesRead === 0) break; size += chunk.bytesRead; }
    if (size < 1 || size > MAX_BYTES) reject("PUBLICATION_EVIDENCE_SIZE_INVALID");
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}
async function referenced(root, value, code) {
  object(value, ["path", "sha256"], code); digest(value.sha256, code);
  const bytes = await bytesAt(root, value.path); if (sha256(bytes) !== value.sha256) reject(code);
  return bytes;
}
function parseJson(bytes, code) { try { return JSON.parse(bytes.toString("utf8")); } catch { reject(code); } }
function visibleText(bytes) {
  let value; try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { reject("PUBLICATION_ARTIFACT_ENCODING_INVALID"); }
  const visible = value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, n => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " })[n]).replace(/\s+/g, " ");
  if (PLACEHOLDERS.test(visible)) reject("PUBLICATION_PLACEHOLDER_FOUND");
  return visible;
}

/** No cookies, auth, redirects or response-body logging. Static versioned UTF-8
 * policy artifacts are required; a client-side app shell is insufficient. */
export async function fetchServedPage(url) {
  const response = await fetch(url, { redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(10_000), headers: { accept: "text/html,text/plain,text/markdown", "cache-control": "no-cache" } });
  if (response.status !== 200 || response.url !== url || !response.body || !/^text\/(?:html|plain|markdown)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) reject("PUBLICATION_SERVED_PAGE_UNVERIFIED");
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BYTES) reject("PUBLICATION_SERVED_PAGE_TOO_LARGE"); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

/** Approval registry pin must come from reviewed operator configuration, never
 * from the proposed manifest. Network injection exists only for local tests. */
export async function evaluatePublicationPolicy({ manifestPath, approvalRegistryPath, approvalRegistrySha256, now = new Date(), fetchPage = fetchServedPage } = {}) {
  const evaluatedAt = now.toISOString();
  try {
    if (!manifestPath) reject("PUBLICATION_MANIFEST_REQUIRED");
    if (!approvalRegistryPath || !HEX.test(approvalRegistrySha256 ?? "")) reject("PUBLICATION_APPROVAL_REGISTRY_PIN_REQUIRED");
    const root = await realpath(dirname(resolve(manifestPath)));
    const manifestBytes = await bytesAt(root, relative(root, resolve(manifestPath)));
    const manifest = object(parseJson(manifestBytes, "PUBLICATION_MANIFEST_INVALID"), ["schemaVersion", "environment", "releaseSha", "origin", "entity", "documents", "supportEvidence", "offerPath"], "PUBLICATION_MANIFEST_INVALID");
    if (manifest.schemaVersion !== "packproof.publication-policy.v1" || manifest.environment !== "production" || !/^[a-f0-9]{40}$/.test(manifest.releaseSha ?? "")) reject("PUBLICATION_MANIFEST_INVALID");
    const originUrl = publicUrl(manifest.origin, "PUBLICATION_ORIGIN_INVALID");
    if (originUrl.origin !== manifest.origin) reject("PUBLICATION_ORIGIN_INVALID");
    const entity = object(manifest.entity, ["legalName", "contactAddress", "contactEmail", "supportEmail", "supportUrl"], "PUBLICATION_ENTITY_REQUIRED");
    text(entity.legalName, "PUBLICATION_ENTITY_REQUIRED", { min: 3 }); text(entity.contactAddress, "PUBLICATION_CONTACT_REQUIRED", { min: 12 });
    email(entity.contactEmail, "PUBLICATION_CONTACT_REQUIRED"); email(entity.supportEmail, "PUBLICATION_SUPPORT_REQUIRED");
    publicUrl(entity.supportUrl, "PUBLICATION_SUPPORT_REQUIRED");
    const entitySha256 = canonicalSha256(entity);
    const registryBytes = await boundedRead(approvalRegistryPath);
    if (registryBytes.length > MAX_BYTES || sha256(registryBytes) !== approvalRegistrySha256) reject("PUBLICATION_APPROVAL_REGISTRY_PIN_MISMATCH");
    const registry = object(parseJson(registryBytes, "PUBLICATION_APPROVAL_REGISTRY_INVALID"), ["schemaVersion", "environment", "origin", "validUntil", "approvals", "workflowVerifications"], "PUBLICATION_APPROVAL_REGISTRY_INVALID");
    if (registry.schemaVersion !== "packproof.publication-approval-registry.v1" || registry.environment !== manifest.environment || registry.origin !== manifest.origin) reject("PUBLICATION_APPROVAL_REGISTRY_INVALID");
    const validUntil = timestamp(registry.validUntil, "PUBLICATION_APPROVAL_REGISTRY_EXPIRED");
    if (validUntil <= now.getTime()) reject("PUBLICATION_APPROVAL_REGISTRY_EXPIRED");
    for (const [key, actorKey] of [["approvals", "approverId"], ["workflowVerifications", "verifierId"]]) {
      if (!Array.isArray(registry[key]) || registry[key].length < 1 || registry[key].length > 100) reject("PUBLICATION_APPROVAL_REGISTRY_INVALID");
      for (const entry of registry[key]) { object(entry, ["recordSha256", actorKey], "PUBLICATION_APPROVAL_REGISTRY_INVALID"); digest(entry.recordSha256, "PUBLICATION_APPROVAL_REGISTRY_INVALID"); id(entry[actorKey], "PUBLICATION_APPROVAL_REGISTRY_INVALID"); }
    }
    object(manifest.documents, KINDS, "PUBLICATION_DOCUMENTS_REQUIRED");
    const documents = {}; const documentBytes = new Map(); const content = [];
    for (const kind of KINDS) {
      const document = object(manifest.documents[kind], ["version", "artifact", "approvalRecord", "servedUrl"], "PUBLICATION_DOCUMENT_INVALID");
      id(document.version, "PUBLICATION_DOCUMENT_VERSION_REQUIRED");
      const servedUrl = publicUrl(document.servedUrl, "PUBLICATION_SERVED_URL_INVALID");
      if (servedUrl.origin !== manifest.origin) reject("PUBLICATION_SERVED_ORIGIN_MISMATCH");
      const bytes = await referenced(root, document.artifact, "PUBLICATION_ARTIFACT_HASH_MISMATCH");
      const visible = visibleText(bytes); content.push(visible);
      const requiredVisible = [document.version, entity.legalName, kind === "support" ? entity.supportEmail : entity.contactEmail];
      if (bytes.length < 80 || requiredVisible.some(value => !visible.includes(value))) reject("PUBLICATION_DOCUMENT_CONTENT_INCOMPLETE");
      const approvalBytes = await referenced(root, document.approvalRecord, "PUBLICATION_APPROVAL_RECORD_HASH_MISMATCH");
      const approval = object(parseJson(approvalBytes, "PUBLICATION_APPROVAL_RECORD_INVALID"), ["schemaVersion", "status", "documentKind", "version", "artifactSha256", "entitySha256", "reference", "approvedAt", "approverId"], "PUBLICATION_APPROVAL_RECORD_INVALID");
      if (approval.schemaVersion !== "packproof.policy-approval.v1" || approval.status !== "approved" || approval.documentKind !== kind || approval.version !== document.version
        || approval.artifactSha256 !== document.artifact.sha256 || approval.entitySha256 !== entitySha256) reject("PUBLICATION_DOCUMENT_NOT_APPROVED");
      id(approval.reference, "PUBLICATION_DATED_APPROVAL_REQUIRED"); id(approval.approverId, "PUBLICATION_DATED_APPROVAL_REQUIRED");
      if (timestamp(approval.approvedAt, "PUBLICATION_DATED_APPROVAL_REQUIRED") > now.getTime()) reject("PUBLICATION_APPROVAL_IN_FUTURE");
      if (!registry.approvals.some(entry => entry.recordSha256 === document.approvalRecord.sha256 && entry.approverId === approval.approverId)) reject("PUBLICATION_APPROVAL_NOT_TRUSTED");
      documentBytes.set(kind, bytes);
      documents[kind] = { version: document.version, artifactSha256: document.artifact.sha256, approvalReference: approval.reference, approvalRecordSha256: document.approvalRecord.sha256, servedUrl: servedUrl.href, verifiedAt: evaluatedAt };
    }
    if (!content.some(value => value.includes(entity.contactAddress)) || !content.some(value => value.includes(entity.supportUrl))) reject("PUBLICATION_CONTACT_CONTENT_MISSING");
    if (new Set(Object.values(documents).map(document => document.servedUrl)).size !== KINDS.length) reject("PUBLICATION_DOCUMENT_URLS_NOT_DISTINCT");
    const supportBytes = await referenced(root, manifest.supportEvidence, "PUBLICATION_SUPPORT_EVIDENCE_HASH_MISMATCH");
    const support = object(parseJson(supportBytes, "PUBLICATION_SUPPORT_EVIDENCE_INVALID"), ["schemaVersion", "source", "reference", "verifiedAt", "verifierId", "environment", "origin", "releaseSha", "entitySha256", "supportEmail", "supportUrl", "checks"], "PUBLICATION_SUPPORT_EVIDENCE_INVALID");
    if (support.schemaVersion !== "packproof.support-workflow-verification.v1" || support.source !== "observed" || support.environment !== manifest.environment || support.origin !== manifest.origin
      || support.releaseSha !== manifest.releaseSha || support.entitySha256 !== entitySha256 || support.supportEmail !== entity.supportEmail || support.supportUrl !== entity.supportUrl) reject("PUBLICATION_SUPPORT_EVIDENCE_UNVERIFIED");
    id(support.reference, "PUBLICATION_SUPPORT_EVIDENCE_INVALID"); id(support.verifierId, "PUBLICATION_SUPPORT_EVIDENCE_INVALID");
    const supportAt = timestamp(support.verifiedAt, "PUBLICATION_SUPPORT_EVIDENCE_INVALID");
    if (supportAt > now.getTime() || now.getTime() - supportAt >= 30 * DAY) reject("PUBLICATION_SUPPORT_EVIDENCE_STALE");
    const requiredChecks = ["supportIntake", "supportReply", "formerSubscriberExport"];
    object(support.checks, requiredChecks, "PUBLICATION_SUPPORT_CHECKS_REQUIRED");
    for (const key of requiredChecks) {
      const check = object(support.checks[key], ["state", "evidenceReference", "evidence"], "PUBLICATION_SUPPORT_CHECKS_REQUIRED");
      if (check.state !== "passed") reject("PUBLICATION_SUPPORT_CHECK_FAILED");
      id(check.evidenceReference, "PUBLICATION_SUPPORT_EVIDENCE_INVALID");
      await referenced(root, check.evidence, "PUBLICATION_SUPPORT_CHECK_EVIDENCE_MISMATCH");
    }
    if (!registry.workflowVerifications.some(entry => entry.recordSha256 === manifest.supportEvidence.sha256 && entry.verifierId === support.verifierId)) reject("PUBLICATION_SUPPORT_EVIDENCE_NOT_TRUSTED");
    const offer = object(parseJson(await bytesAt(root, manifest.offerPath), "PUBLICATION_OFFER_INVALID"), ["schemaVersion", "version", "status", "currency", "priceMinor", "interval", "includedFinalizedProofs", "maxRecordingBytes", "maxRecordingSeconds", "retentionPolicyVersion", "preservationStandard", "supplements", "overage", "approvedTermsReference"], "PUBLICATION_OFFER_INVALID");
    if (offer.schemaVersion !== "packproof.billing.v1" || offer.status !== "approved" || offer.currency !== "USD" || !["monthly", "usage"].includes(offer.interval)
      || offer.preservationStandard !== "canonical-original-v1" || offer.supplements !== "included_within_published_allowance" || offer.overage !== "block_new_capture"
      || !Number.isSafeInteger(offer.priceMinor) || offer.priceMinor < 0 || ["includedFinalizedProofs", "maxRecordingBytes", "maxRecordingSeconds"].some(key => !Number.isSafeInteger(offer[key]) || offer[key] < 1)
      || offer.approvedTermsReference !== documents.terms.approvalReference) reject("PUBLICATION_OFFER_APPROVAL_MISMATCH");
    id(offer.version, "PUBLICATION_OFFER_INVALID"); id(offer.retentionPolicyVersion, "PUBLICATION_OFFER_INVALID");
    // Defer network requests until local records and independently pinned hashes
    // pass. A supplied capture alone never proves today's served pages match.
    for (const kind of KINDS) {
      let served; try { served = await fetchPage(documents[kind].servedUrl); } catch { reject("PUBLICATION_SERVED_PAGE_UNVERIFIED"); }
      if (!(served instanceof Uint8Array) || served.byteLength > MAX_BYTES || sha256(served) !== sha256(documentBytes.get(kind))) reject("PUBLICATION_SERVED_PAGE_HASH_MISMATCH");
    }
    const receipt = { schemaVersion: "packproof.publication-policy-receipt.v1", state: "passed", offerVersion: offer.version, canonicalOfferSha256: canonicalSha256(offer),
      approvedTermsReference: offer.approvedTermsReference, releaseSha: manifest.releaseSha, entitySha256, approvalRegistrySha256, documents,
      supportEvidenceSha256: manifest.supportEvidence.sha256, evaluatedAt, expiresAt: new Date(Math.min(now.getTime() + DAY, validUntil, supportAt + 30 * DAY)).toISOString() };
    return { ...receipt, receiptSha256: canonicalSha256(receipt) };
  } catch (error) {
    const code = error instanceof Error && /^PUBLICATION_[A-Z_]+$/.test(error.message) ? error.message : "PUBLICATION_INPUT_UNREADABLE_OR_INVALID";
    return { schemaVersion: "packproof.publication-policy-receipt.v1", state: "blocked", evaluatedAt, reasons: [code] };
  }
}

async function main() {
  const args = process.argv.slice(2); const allowed = new Set(["--manifest", "--approval-registry", "--output"]); const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]) || !args[index + 1] || args[index + 1].startsWith("--") || Object.hasOwn(parsed, args[index])) reject("PUBLICATION_CLI_ARGUMENT_INVALID");
    parsed[args[index]] = args[index + 1];
  }
  const result = await evaluatePublicationPolicy({ manifestPath: parsed["--manifest"], approvalRegistryPath: parsed["--approval-registry"], approvalRegistrySha256: process.env.PACKPROOF_PUBLICATION_APPROVAL_REGISTRY_SHA256 });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (parsed["--output"]) {
    const destination = resolve(parsed["--output"]); const temporary = `${destination}.${randomUUID()}.tmp`;
    // Replace a previous passed receipt with the blocked report on a failed run.
    // An earlier success cannot silently survive a later failed release check.
    await writeFile(temporary, output, { mode: 0o600, flag: "wx" }); await rename(temporary, destination);
  }
  process.stdout.write(output); process.exitCode = result.state === "passed" ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write("PUBLICATION_GATE_EXECUTION_FAILED\n"); process.exitCode = 1; });
}
