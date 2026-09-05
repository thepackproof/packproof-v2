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
  const pkg = createProofPackage({
    proofId,
    manifestId: manifest.manifestId,
    manifest: manifest.manifest,
    expectedSha256: manifest.sha256,
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
  const evidenceIndex = [];
  for (const evidence of core.evidence) {
    const object = await store.get(evidence.objectKey);
    if (
      !object ||
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
        } as Record<string, string>
      )[evidence.contentType] ?? "bin";
    const name = `evidence/${evidence.evidenceId}.${extension}`;
    files.push({ name, bytes: object.body });
    evidenceIndex.push({
      evidenceId: evidence.evidenceId,
      path: name,
      sha256: evidence.sha256,
    });
  }
  json("integrity/evidence.json", evidenceIndex);
  json("integrity/signatures.json", {
    manifestSignature: null,
    trustedTimestamp: null,
    status: "not-configured",
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
      if (
        !stored ||
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
      stageMedia.push({ evidenceId: evidence.evidenceId, path });
    }
    stageIndex.push({
      stageId: stage.stageId,
      sha256: stage.sha256,
      manifestPath,
      evidence: stageMedia,
    });
  }
  json("lifecycle/stages.json", stageIndex);
  json("integrity/hashes.json", Object.fromEntries(files.map((f) => [f.name, sha256Hex(f.bytes)])));
  files.push({
    name: "README.txt",
    bytes: Buffer.from(
      "PackProof portable evidence package v1\nmanifest.json is the frozen canonical record.\nLater shipping and access events are supplements, outside that frozen manifest.\nVerify manifest SHA-256 against a digest obtained separately from PackProof.\nSelf-consistency does not establish origin or the truth of recorded assertions.\nUse backend/scripts/verify-proof-package.py from the PackProof repository.\n",
    ),
  });
  await appendAudit(db, {
    proofId,
    actorUserId: userId,
    eventType: "PROOF_PACKAGE_EXPORTED",
    eventData: {
      manifestSha256: manifest.sha256,
      evidenceCount: core.evidence.length,
    },
    at: clock.now(),
  });
  return zipFiles(files);
}
