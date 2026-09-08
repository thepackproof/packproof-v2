import type { Database } from "../db/database.js";
import type { ObjectStore } from "../s3/object-store.js";
import type { Clock } from "../clock.js";
import { getProofForUser } from "./proofs.js";
import { getManifest } from "./finalize.js";
import { getShipmentIntegrity } from "./shipment-integrity.js";
import { appendAudit } from "./audit.js";
import { createProofPackage } from "./proof-package.js";
import { DomainError } from "./errors.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { getRetentionControls } from "./retention-controls.js";
import { listCommerceStages } from "./commerce-lifecycle.js";
import { requireManifestSignatureAlgorithm } from "./manifest-signing.js";
import type { ManifestRow } from "./types.js";
import { Readable } from "node:stream";
import { collectSmallZip, streamZip, zipBytes, ZipStreamError, type ZipStreamEntry } from "../export/zip-stream.js";
import { authorizeProofAccess } from "./proof-access.js";
import { getProofSupplementSnapshot } from "./proof-supplements.js";

export async function getEvidenceReview(
  db: Database,
  clock: Clock,
  userId: string,
  proofId: string,
) {
  const proof = await getProofForUser(db, userId, proofId);
  const manifest = proof.status === "FINALIZED" ? await getManifest(db, userId, proofId) : null;
  const integrity = manifest
    ? {
        manifestSha256: manifest.sha256,
        manifestDigestValid: sha256Hex(manifest.canonicalJson) === manifest.sha256,
        signatureVerified: false,
        signaturePresent: Boolean(manifest.signature),
        signingKeyId: manifest.signature?.keyId ?? null,
      }
    : null;
  await appendAudit(db, {
    proofId,
    actorUserId: userId,
    eventType: "PROOF_ACCESSED",
    eventData: { channel: "evidence_review" },
    at: clock.now(),
  });
  return {
    proof,
    integrity,
    shipmentIntegrity:
      proof.status === "FINALIZED" ? await getShipmentIntegrity(db, proofId) : null,
    accessHistory: proof.events.filter((e) =>
      ["PROOF_ACCESSED", "PROOF_VIEWED_VIA_ACCESS_LINK", "PROOF_PACKAGE_EXPORTED", "ARCHIVE_CONTENT_PREPARED"].includes(
        e.eventType,
      ),
    ),
    retention: await getRetentionControls(db, clock, userId, proofId),
    exportAvailable: proof.status === "FINALIZED",
  };
}
/** Small compatibility helper. Production routes must pipe exportEvidencePackageStream. */
export async function exportEvidencePackage(db: Database, clock: Clock, store: ObjectStore, userId: string, proofId: string): Promise<Buffer> {
  return collectSmallZip(await exportEvidencePackageStream(db, clock, store, userId, proofId));
}
interface FrozenMedia { evidenceId: string; objectKey: string; objectVersionId?: string; sha256: string; byteSize: number; contentType?: string; }
interface PreservedRow { object_key: string; object_version_id: string | null; sha256: string; byte_size: number | string; content_type: string; }

/** Exact frozen manifests and sources, emitted with bounded memory and complete end-of-stream checks. */
export async function exportEvidencePackageStream(db: Database, clock: Clock, store: ObjectStore, userId: string, proofId: string,
  options: { maximumMediaBytes?: number } = {}): Promise<Readable> {
  const proof = await getProofForUser(db, userId, proofId), manifest = await getManifest(db, userId, proofId);
  const maximumMediaBytes = options.maximumMediaBytes ?? 200 * 1024 * 1024;
  if (!Number.isSafeInteger(maximumMediaBytes) || maximumMediaBytes < 0 || maximumMediaBytes > 200 * 1024 * 1024) throw packageTooLarge();
  if (Buffer.byteLength(manifest.canonicalJson) > 8 * 1024 * 1024) throw packageTooLarge();
  const signatureRow = (await db.query<ManifestRow>("SELECT * FROM final_manifests WHERE id = $1 AND proof_id = $2", [manifest.manifestId, proofId])).rows[0];
  const signature = signatureRow?.signature_base64 ? { algorithm: requireManifestSignatureAlgorithm(signatureRow.signature_algorithm),
    keyId: signatureRow.signing_key_id!, signatureBase64: signatureRow.signature_base64, signedAt: new Date(signatureRow.signed_at!).toISOString() } : null;
  const supplementSnapshot = { schema: "packproof.signed-supplement-snapshot.v1", proofId,
    ...await getProofSupplementSnapshot(db, proofId), snapshotAt: clock.now().toISOString() };
  if (supplementSnapshot.coreManifestSha256 !== manifest.sha256) throw integrityFailure("Supplement snapshot is not bound to the frozen manifest");
  const supplementSource = { path: "proof-supplements.json", sequence: supplementSnapshot.sequence, sha256: supplementSnapshot.sha256, snapshotAt: supplementSnapshot.snapshotAt };
  const pkg = { ...createProofPackage({ proofId, manifestId: manifest.manifestId, manifest: manifest.manifest, expectedSha256: manifest.sha256, signature }),
    sources: { signedSupplements: supplementSource } };
  const core = manifest.manifest as { transaction: unknown; participants: unknown; attestations?: unknown; shipping: unknown; evidence: FrozenMedia[] };
  const stages = (await listCommerceStages(db, proofId)).filter(stage => stage.finalizedAt).map(stage => {
    const frozen = stage.manifest as { baseManifestSha256: string; evidence: FrozenMedia[] };
    const encoded = canonicalize(frozen);
    if (frozen.baseManifestSha256 !== manifest.sha256 || sha256Hex(encoded) !== stage.sha256)
      throw integrityFailure("Lifecycle manifest failed verification");
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw packageTooLarge();
    return { ...stage, frozen, encoded };
  });
  const selected = [...core.evidence, ...stages.flatMap(stage => stage.frozen.evidence)];
  let total = 0;
  if (selected.length > 1000 || stages.length > 1000) throw packageTooLarge();
  for (const item of selected) {
    if (!Number.isSafeInteger(item.byteSize) || item.byteSize < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw integrityFailure("Frozen media metadata is invalid");
    if ((total += item.byteSize) > maximumMediaBytes) throw packageTooLarge();
  }
  const shipment = await getShipmentIntegrity(db, proofId);
  async function openFrozen(evidence: FrozenMedia, stageId?: string): Promise<Readable | null> {
    await authorizeProofAccess(db, proofId, userId);
    const row = stageId
      ? (await db.query<PreservedRow>("SELECT e.object_key,e.object_version_id,e.sha256,e.byte_size,e.content_type FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id WHERE e.id=$1 AND e.stage_id=$2 AND s.proof_id=$3 AND e.committed_at IS NOT NULL AND e.discarded_at IS NULL", [evidence.evidenceId, stageId, proofId])).rows[0]
      : (await db.query<PreservedRow>("SELECT object_key,object_version_id,sha256,byte_size,content_type FROM evidence WHERE id=$1 AND proof_id=$2 AND validation_status='COMMITTED'", [evidence.evidenceId, proofId])).rows[0];
    if (row && (row.object_key !== evidence.objectKey || row.sha256 !== evidence.sha256 || Number(row.byte_size) !== evidence.byteSize))
      throw integrityFailure("Stored source metadata differs from the frozen manifest");
    const versionId = evidence.objectVersionId ?? row?.object_version_id ?? undefined;
    // Legacy fallback is restricted to an immutable content-addressed key for these exact bytes.
    if (!versionId && !evidence.objectKey.endsWith(`/committed/sha256-${evidence.sha256}`))
      throw new DomainError("EVIDENCE_VERSION_UNAVAILABLE", "This legacy source has no pinned preserved version; download is unavailable until its reference is reviewed", 409);
    if (store.getStream) {
      const source = await store.getStream(evidence.objectKey, { versionId });
      if (!source) return null;
      if ((versionId && source.versionId !== versionId) || source.byteSize !== evidence.byteSize) {
        source.body.destroy(); throw integrityFailure("Storage did not return the frozen source version and length");
      }
      return source.body;
    }
    // Compatibility adapters may collect only a small original and still use the exact pinned reference.
    if (evidence.byteSize > 5 * 1024 * 1024) throw new DomainError("STREAMING_STORAGE_REQUIRED", "Archive download requires a streaming storage adapter", 503);
    const source = await store.get(evidence.objectKey, { versionId });
    return source ? Readable.from([source.body], { objectMode: false, highWaterMark: 64 * 1024 }) : null;
  }
  async function* entries(): AsyncGenerator<ZipStreamEntry> {
    const hashes: Record<string, string> = {}, omissions: Array<{ evidenceId: string; stageId?: string; reason: "UNAVAILABLE" }> = [];
    const json = (name: string, value: unknown) => {
      const bytes = Buffer.from(canonicalize(value)); if (bytes.length > 8 * 1024 * 1024) throw packageTooLarge();
      hashes[name] = sha256Hex(bytes); return zipBytes(name, bytes);
    };
    const bytesEntry = (name: string, bytes: Buffer) => { hashes[name] = sha256Hex(bytes); return zipBytes(name, bytes); };
    yield json("package.json", pkg); yield bytesEntry("manifest.json", Buffer.from(manifest.canonicalJson));
    yield json("proof-supplements.json", supplementSnapshot);
    yield json("transaction.json", core.transaction); yield json("participants.json", core.participants);
    yield json("attestations.json", core.attestations ?? []);
    yield json("shipping.json", { frozen: core.shipping, supplement: shipment, observations: proof.shipmentObservations });
    yield json("events.json", proof.events);
    const evidenceIndex: Array<Record<string, unknown>> = [];
    for (const evidence of core.evidence) {
      const source = await openFrozen(evidence);
      if (!source) {
        omissions.push({ evidenceId: evidence.evidenceId, reason: "UNAVAILABLE" });
        evidenceIndex.push({ evidenceId: evidence.evidenceId, sha256: evidence.sha256, byteSize: evidence.byteSize, status: "OMITTED", reason: "UNAVAILABLE" }); continue;
      }
      const extension = ({ "video/mp4": "mp4", "video/quicktime": "mov", "image/jpeg": "jpg", "image/png": "png", "video/webm": "webm", "application/pdf": "pdf" } as Record<string, string>)[(evidence.contentType ?? "").split(";")[0].trim().toLowerCase()] ?? "bin";
      const name = `evidence/${evidence.evidenceId}.${extension}`;
      try { yield { name, body: source, byteSize: evidence.byteSize, sha256: evidence.sha256, onComplete: result => { hashes[name] = result.sha256; } }; }
      finally { source.destroy(); }
      evidenceIndex.push({ evidenceId: evidence.evidenceId, path: name, sha256: evidence.sha256, byteSize: evidence.byteSize, status: "INCLUDED" });
    }
    yield json("integrity/evidence.json", evidenceIndex);
    yield json("integrity/signatures.json", { manifestSignature: signature, trustedTimestamp: null, status: signature ? "SIGNED_REQUIRES_INDEPENDENT_TRUST_KEY" : "UNSIGNED", verification: "Compare the manifest digest with an independently obtained value" });
    const stageIndex: Array<Record<string, unknown>> = [];
    for (const stage of stages) {
      const manifestPath = `lifecycle/${stage.stageId}/manifest.json`; yield bytesEntry(manifestPath, Buffer.from(stage.encoded));
      const media: Array<Record<string, unknown>> = [];
      for (const evidence of stage.frozen.evidence) {
        const source = await openFrozen(evidence, stage.stageId);
        if (!source) {
          omissions.push({ evidenceId: evidence.evidenceId, stageId: stage.stageId, reason: "UNAVAILABLE" });
          media.push({ evidenceId: evidence.evidenceId, sha256: evidence.sha256, byteSize: evidence.byteSize, status: "OMITTED", reason: "UNAVAILABLE" }); continue;
        }
        const name = `lifecycle/${stage.stageId}/evidence/${evidence.evidenceId}.bin`;
        try { yield { name, body: source, byteSize: evidence.byteSize, sha256: evidence.sha256, onComplete: result => { hashes[name] = result.sha256; } }; }
        finally { source.destroy(); }
        media.push({ evidenceId: evidence.evidenceId, path: name, sha256: evidence.sha256, byteSize: evidence.byteSize, status: "INCLUDED" });
      }
      stageIndex.push({ stageId: stage.stageId, sha256: stage.sha256, manifestPath, evidence: media });
    }
    yield json("lifecycle/stages.json", stageIndex);
    yield json("archive.json", {
      schema: "packproof.proof-archive.v1", canonicalization: "packproof.sorted-json.v1",
      snapshot: { proofId, manifestId: manifest.manifestId, manifestSha256: manifest.sha256 }, exportedAt: clock.now().toISOString(),
      disclosure: { kind: "PARTICIPANT_FULL_RECORD", policyVersion: 1, exportedBy: userId }, omissions, derivatives: [],
      sources: { canonicalRecord: "manifest.json", evidenceInventory: "integrity/evidence.json", lifecycleManifests: "lifecycle/stages.json", supplements: ["shipping.json", "events.json"], signedSupplements: supplementSource },
      supplementIntegrity: { signedSupplements: "SEPARATELY_SIGNED_RECEIVED_CHAIN_REQUIRES_INDEPENDENT_TRUST",
        otherSupplementalFiles: "SELF_CONSISTENCY_ONLY_NOT_COVERED_BY_ROOT_SIGNATURE" },
      limitations: ["Signing time is not filming time", "Integrity is not a physical truth verdict", "Offline trust cannot discover later revocations", "Unavailable media has not been verified"],
    });
    yield bytesEntry("README.txt", Buffer.from("PackProof portable evidence package v1\nmanifest.json is the frozen canonical record.\nproof-supplements.json contains the separately signed received supplement chain, bound to that core record.\nEach supplement requires independent signing-key trust; its dated head cannot establish that no later supplements exist.\nLegacy shipping.json and events.json remain self-consistency-only files outside the root signature.\nVerify manifest SHA-256 against a digest obtained separately from PackProof.\nFile self-consistency does not establish origin or the truth of recorded assertions.\nObtain the read-only verifier independently from the PackProof repository: verifier/verify.py.\nUse a separately obtained trust list or signed registry with an independently pinned authority; package contents cannot make their own key trusted.\nUnavailable files are explicit omissions and have not been verified.\n"));
    yield zipBytes("integrity/hashes.json", Buffer.from(canonicalize(hashes)));
    // The ZIP directory and its authorization checks have not completed here.
    // Preparing content establishes neither a complete archive nor delivery.
    await appendAudit(db, { proofId, actorUserId: userId, eventType: "ARCHIVE_CONTENT_PREPARED", eventData: { manifestSha256: manifest.sha256, evidenceCount: core.evidence.length, omittedEvidenceCount: omissions.length, signaturePresent: Boolean(signature), archiveCompletion: "UNCONFIRMED", delivery: "UNCONFIRMED" }, at: clock.now() });
  }
  const zip = streamZip(entries(), { beforeChunk: () => authorizeProofAccess(db, proofId, userId).then(() => undefined) });
  return Readable.from((async function* () {
    try { for await (const chunk of zip) yield chunk; }
    catch (error) { if (error instanceof ZipStreamError) throw error.code === "ZIP_TOO_LARGE" ? packageTooLarge() : integrityFailure(error.message); throw error; }
    finally { zip.destroy(); }
  })(), { objectMode: false, highWaterMark: 64 * 1024 });
}
function packageTooLarge() { return new DomainError("PACKAGE_TOO_LARGE", "Package exceeds its bounded size limit; download individual evidence files", 413); }
function integrityFailure(message: string) { return new DomainError("EVIDENCE_INTEGRITY_FAILURE", message, 409); }
