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
import { zipFiles } from "../export/zip.js";
import { getRetentionControls } from "./retention-controls.js";
import { listCommerceStages } from "./commerce-lifecycle.js";
import { requireManifestSignatureAlgorithm } from "./manifest-signing.js";
import type { ManifestRow } from "./types.js";

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
      ["PROOF_ACCESSED", "PROOF_VIEWED_VIA_ACCESS_LINK", "PROOF_PACKAGE_EXPORTED"].includes(
        e.eventType,
      ),
    ),
    retention: await getRetentionControls(db, clock, userId, proofId),
    exportAvailable: proof.status === "FINALIZED",
  };
}
export async function exportEvidencePackage(
  db: Database,
  clock: Clock,
  store: ObjectStore,
  userId: string,
  proofId: string,
): Promise<Buffer> {
  const proof = await getProofForUser(db, userId, proofId);
  const manifest = await getManifest(db, userId, proofId);
  const signatureRow = (await db.query<ManifestRow>(
    "SELECT * FROM final_manifests WHERE id = $1 AND proof_id = $2",
    [manifest.manifestId, proofId],
  )).rows[0];
  const signature = signatureRow?.signature_base64 ? {
    algorithm: requireManifestSignatureAlgorithm(signatureRow.signature_algorithm),
    keyId: signatureRow.signing_key_id!,
    signatureBase64: signatureRow.signature_base64,
    signedAt: new Date(signatureRow.signed_at!).toISOString(),
  } : null;
  const pkg = createProofPackage({
    proofId,
    manifestId: manifest.manifestId,
    manifest: manifest.manifest,
    expectedSha256: manifest.sha256,
    signature,
  });
  const core = manifest.manifest as {
    transaction: unknown;
    participants: unknown;
    attestations?: unknown;
    shipping: unknown;
    evidence: Array<{
      evidenceId: string;
      objectKey: string;
      sha256: string;
      byteSize: number;
      contentType: string;
    }>;
  };
  if (
    core.evidence.reduce((size, e) => size + e.byteSize, 0) > 200 * 1024 * 1024 ||
    core.evidence.length > 1000
  )
    throw new DomainError(
      "PACKAGE_TOO_LARGE",
      "Package exceeds 200 MB; download individual evidence files",
      413,
    );
  const files: Array<{ name: string; bytes: Buffer }> = [];
  const json = (name: string, value: unknown) =>
    files.push({ name, bytes: Buffer.from(canonicalize(value)) });
  json("package.json", pkg);
  files.push({
    name: "manifest.json",
    bytes: Buffer.from(manifest.canonicalJson),
  });
  json("transaction.json", core.transaction);
  json("participants.json", core.participants);
  json("attestations.json", core.attestations ?? []);
  json("shipping.json", {
    frozen: core.shipping,
    supplement: await getShipmentIntegrity(db, proofId),
    observations: proof.shipmentObservations,
  });
  json("events.json", proof.events);
  const omissions: Array<{ evidenceId: string; stageId?: string; reason: "UNAVAILABLE" }> = [];
  const evidenceIndex = [];
  for (const evidence of core.evidence) {
    const object = await store.get(evidence.objectKey);
    if (!object) {
      omissions.push({ evidenceId: evidence.evidenceId, reason: "UNAVAILABLE" });
      evidenceIndex.push({ evidenceId: evidence.evidenceId, sha256: evidence.sha256, byteSize: evidence.byteSize, status: "OMITTED", reason: "UNAVAILABLE" });
      continue;
    }
    if (
      object.body.length !== evidence.byteSize ||
      sha256Hex(object.body) !== evidence.sha256
    )
      throw new DomainError(
        "EVIDENCE_INTEGRITY_FAILURE",
        "Evidence bytes do not match the frozen manifest",
        409,
      );
    const extension =
      (
        {
          "video/mp4": "mp4",
          "video/quicktime": "mov",
          "image/jpeg": "jpg",
          "image/png": "png",
          "video/webm": "webm",
          "application/pdf": "pdf",
        } as Record<string, string>
      )[evidence.contentType.split(";")[0].trim().toLowerCase()] ?? "bin";
    const name = `evidence/${evidence.evidenceId}.${extension}`;
    files.push({ name, bytes: object.body });
    evidenceIndex.push({
      evidenceId: evidence.evidenceId,
      path: name,
      sha256: evidence.sha256,
      byteSize: evidence.byteSize,
      status: "INCLUDED",
    });
  }
  json("integrity/evidence.json", evidenceIndex);
  json("integrity/signatures.json", {
    manifestSignature: signature,
    trustedTimestamp: null,
    status: signature ? "SIGNED_REQUIRES_INDEPENDENT_TRUST_KEY" : "UNSIGNED",
    verification: "Compare the manifest digest with an independently obtained value",
  });
  const stages = await listCommerceStages(db, proofId);
  const stageIndex = [];
  let totalBytes = core.evidence.reduce((size, e) => size + e.byteSize, 0);
  for (const stage of stages.filter((s) => s.finalizedAt)) {
    const stageManifest = stage.manifest as {
      baseManifestSha256: string;
      evidence: Array<{
        evidenceId: string;
        sha256: string;
        byteSize: number;
        objectKey: string;
      }>;
    };
    const encoded = canonicalize(stageManifest);
    if (stageManifest.baseManifestSha256 !== manifest.sha256 || sha256Hex(encoded) !== stage.sha256)
      throw new DomainError(
        "EVIDENCE_INTEGRITY_FAILURE",
        "Lifecycle manifest failed verification",
        409,
      );
    const manifestPath = `lifecycle/${stage.stageId}/manifest.json`;
    files.push({ name: manifestPath, bytes: Buffer.from(encoded) });
    const stageMedia = [];
    for (const evidence of stageManifest.evidence) {
      totalBytes += evidence.byteSize;
      if (totalBytes > 200 * 1024 * 1024)
        throw new DomainError(
          "PACKAGE_TOO_LARGE",
          "Package exceeds 200 MB including lifecycle media",
          413,
        );
      const stored = await store.get(evidence.objectKey);
      if (!stored) {
        omissions.push({ evidenceId: evidence.evidenceId, stageId: stage.stageId, reason: "UNAVAILABLE" });
        stageMedia.push({ evidenceId: evidence.evidenceId, sha256: evidence.sha256, byteSize: evidence.byteSize, status: "OMITTED", reason: "UNAVAILABLE" });
        continue;
      }
      if (
        stored.body.length !== evidence.byteSize ||
        sha256Hex(stored.body) !== evidence.sha256
      )
        throw new DomainError(
          "EVIDENCE_INTEGRITY_FAILURE",
          "Lifecycle media failed verification",
          409,
        );
      const path = `lifecycle/${stage.stageId}/evidence/${evidence.evidenceId}.bin`;
      files.push({ name: path, bytes: stored.body });
      stageMedia.push({ evidenceId: evidence.evidenceId, path, sha256: evidence.sha256, byteSize: evidence.byteSize, status: "INCLUDED" });
    }
    stageIndex.push({
      stageId: stage.stageId,
      sha256: stage.sha256,
      manifestPath,
      evidence: stageMedia,
    });
  }
  json("lifecycle/stages.json", stageIndex);
  json("archive.json", {
    schema: "packproof.proof-archive.v1",
    canonicalization: "packproof.sorted-json.v1",
    snapshot: { proofId, manifestId: manifest.manifestId, manifestSha256: manifest.sha256 },
    exportedAt: clock.now().toISOString(),
    disclosure: { kind: "PARTICIPANT_FULL_RECORD", policyVersion: 1, exportedBy: userId },
    omissions,
    derivatives: [],
    sources: {
      canonicalRecord: "manifest.json",
      evidenceInventory: "integrity/evidence.json",
      lifecycleManifests: "lifecycle/stages.json",
      supplements: ["shipping.json", "events.json"],
    },
    supplementIntegrity: "SELF_CONSISTENCY_ONLY_NOT_COVERED_BY_ROOT_SIGNATURE",
    limitations: ["Signing time is not filming time", "Integrity is not a physical truth verdict", "Offline trust cannot discover later revocations", "Unavailable media has not been verified"],
  });
  files.push({
    name: "README.txt",
    bytes: Buffer.from(
      "PackProof portable evidence package v1\nmanifest.json is the frozen canonical record.\nLater shipping and access events are supplements, outside that frozen manifest.\nVerify manifest SHA-256 against a digest obtained separately from PackProof.\nSelf-consistency does not establish origin or the truth of recorded assertions.\nObtain the read-only verifier independently from the PackProof repository: verifier/verify.py.\nUse a separately obtained trust list; package contents cannot make their own key trusted.\nUnavailable files are explicit omissions and have not been verified.\n",
    ),
  });
  json("integrity/hashes.json", Object.fromEntries(files.map((f) => [f.name, sha256Hex(f.bytes)])));
  await appendAudit(db, {
    proofId,
    actorUserId: userId,
    eventType: "PROOF_PACKAGE_EXPORTED",
    eventData: {
      manifestSha256: manifest.sha256,
      evidenceCount: core.evidence.length,
      omittedEvidenceCount: omissions.length,
      signaturePresent: Boolean(signature),
    },
    at: clock.now(),
  });
  return zipFiles(files);
}
