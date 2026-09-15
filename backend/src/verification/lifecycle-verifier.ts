import { sha256Hex } from "../hash.js";
import { verifyManifestIntegrity, type ManifestSignature } from "../domain/manifest-signing.js";
import { verifyProofSupplementSnapshot, type ProofSupplementView } from "../domain/proof-supplements.js";
import { parseSignedTrustRegistry, verifyWithTrustRegistry, type SignedTrustRegistry } from "../domain/signing-trust.js";
import type { ManifestTrustList } from "../integrity/signing-runtime.js";

/** Independent trust configuration is provided by the caller, never selected from snapshot contents. */
export interface PortableVerificationTrust {
  signedRegistry?: SignedTrustRegistry;
  pinnedRegistryAuthorityKeys?: Record<string, string>;
  trustList?: ManifestTrustList | null;
}
export interface PortableLifecycleSnapshot {
  snapshotId: string; proofId: string; canonicalJson: string; sha256: string; signature: ManifestSignature;
  root: { manifestId: string; proofId: string; canonicalJson: string; sha256: string; signature?: ManifestSignature | null };
  supplements: ProofSupplementView[];
  stages: Array<{ stageId: string; proofId: string; type: string; canonicalJson: string; sha256: string; finalizedAt: string }>;
}
const parse = (raw: string): Record<string, any> => {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error("Invalid signed record size");
  const result: unknown = JSON.parse(raw);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid signed record");
  return result as Record<string, any>;
};
const isTime = (value: unknown): value is string => typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const fieldsAre = (value: unknown, fields: string[]) => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...fields].sort().join();

interface PortableLifecycleVerificationInput {
  snapshot: PortableLifecycleSnapshot; trust: PortableVerificationTrust; now: Date;
  expectedProofId: string; expectedTenantId?: string; expectedSnapshotSha256?: string;
}
/** Verifies stored manifest bytes and sealed references. It deliberately does not fetch evidence bytes. */
export function verifyPortableLifecycleSnapshot(input: PortableLifecycleVerificationInput) {
  try { return verifyStoredLifecycle(input); }
  catch {
    const unknown = { digestValid: false, signaturePresent: false, signatureValid: null, trustedAtSnapshot: false,
      trustCurrent: false, keyStatus: "UNKNOWN", keyId: null };
    return { profile: "packproof.lifecycle-verification.v1", snapshotId: null, proofId: null, tenantId: null,
      tenantBinding: "NOT_ESTABLISHED", snapshotSha256: null, cutoffAt: null, verifiedReceivedSnapshot: false, issues: ["INVALID_INPUT"],
      root: unknown, snapshot: unknown, supplements: [], evidenceAvailability: "NOT_CHECKED", availableFileDigests: "NOT_CHECKED",
      sourceAuthentication: "NOT_INDEPENDENTLY_CHECKED", attestationVerification: "NOT_INDEPENDENTLY_CHECKED", policyCoverage: "NOT_EVALUATED",
      unresolvedConflicts: "NOT_EVALUATED", physicalTruthVerified: false, freshness: "UNKNOWN_OFFLINE",
      currentRevocationKnowledge: "UNAVAILABLE_OFFLINE", completeness: "NOT_ESTABLISHED" };
  }
}
function verifyStoredLifecycle(input: PortableLifecycleVerificationInput) {
  const { snapshot, trust, now } = input;
  if (!snapshot || !snapshot.root || !trust || !Number.isFinite(now.getTime()) || typeof input.expectedProofId !== "string" || !input.expectedProofId
      || !Array.isArray(snapshot.supplements) || snapshot.supplements.length > 256 || !Array.isArray(snapshot.stages) || snapshot.stages.length > 3) throw new Error("Invalid snapshot input");
  let sourceBytes = 0;
  for (const record of [snapshot, snapshot.root, ...snapshot.supplements, ...snapshot.stages]) {
    if (!record || typeof record.canonicalJson !== "string" || Buffer.byteLength(record.canonicalJson) > 8 * 1024 * 1024
        || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error("Invalid snapshot record");
    sourceBytes += Buffer.byteLength(record.canonicalJson);
  }
  if (sourceBytes > 16 * 1024 * 1024) throw new Error("Snapshot records exceed bounds");
  const issues: string[] = [];
  let registry: SignedTrustRegistry | undefined;
  if (trust.signedRegistry) {
    try { registry = parseSignedTrustRegistry(Buffer.from(JSON.stringify(trust.signedRegistry))); }
    catch { issues.push("INVALID_TRUST_REGISTRY"); }
  }
  const check = (record: { canonicalJson: string; sha256: string; signature?: ManifestSignature | null }) => {
    const signature = record.signature;
    if (signature && registry) {
      const result = verifyWithTrustRegistry({ canonicalJson: record.canonicalJson, expectedSha256: record.sha256,
        signature, signedRegistry: registry, pinnedRegistryAuthorityKeys: trust.pinnedRegistryAuthorityKeys ?? {}, now,
        onlineRevocationChecked: false });
      return { digestValid: result.digestValid, signaturePresent: true, signatureValid: result.signatureValid,
        trustedAtSnapshot: result.historicalTrust === "TRUSTED_AT_REGISTRY_SNAPSHOT", trustCurrent: !result.trustSnapshotStale,
        keyStatus: result.keyStatus, keyId: signature.keyId };
    }
    // A failed configured registry cannot fall back to a less strict trust list.
    const list = trust.signedRegistry ? null : trust.trustList;
    const key = signature && list?.keys.find(row => row.keyId === signature.keyId && row.algorithm === signature.algorithm);
    const math = verifyManifestIntegrity({ canonicalJson: record.canonicalJson, expectedSha256: record.sha256,
      signature, publicKeyPem: key ? key.publicKeyPem : null });
    const current = !!list && Date.parse(list.generatedAt) <= now.getTime() && now.getTime() < Date.parse(list.expiresAt);
    return { digestValid: math.digestValid, signaturePresent: math.signaturePresent, signatureValid: math.signatureValid,
      trustedAtSnapshot: !!key && key.status === "ACTIVE" && !!signature && isTime(signature.signedAt) && Date.parse(signature.signedAt) <= now.getTime(),
      trustCurrent: current, keyStatus: key?.status ?? "UNKNOWN", keyId: signature?.keyId ?? null };
  };
  const snapshotCheck = check(snapshot), rootCheck = check(snapshot.root);
  let tenantId: string | null = null, cutoffAt: string | null = null;
  const supplementChecks = snapshot.supplements.map(row => ({ supplementId: row.supplementId, ...check(row) }));
  try {
    const facts = parse(snapshot.canonicalJson), root = parse(snapshot.root.canonicalJson);
    tenantId = facts.tenantId;
    cutoffAt = facts.cutoffAt;
    if (facts.version !== 1 || facts.domain !== "PACKPROOF_LIFECYCLE_SNAPSHOT" || facts.scope !== "SEALED_COMMERCE_LIFECYCLE"
        || !["REVIEW", "CLAIM", "ARCHIVE"].includes(facts.purpose) || root.manifestVersion !== 1) issues.push("UNSUPPORTED_FORMAT");
    const fields = ["version", "domain", "snapshotId", "proofId", "transactionId", "tenantId", "actorUserId", "purpose", "createdAt", "cutoffAt", "scope", "root", "supplements", "stages", "watermark", "limitations"];
    const limits = facts.limitations;
    if (!fieldsAre(facts, fields) || !fieldsAre(facts.root, ["manifestId", "sha256"])
        || !fieldsAre(facts.watermark, ["supplementSequence", "supplementSha256"])
        || !fieldsAre(limits, ["completeness", "freshness", "currentRevocationKnowledge", "excluded"])
        || typeof facts.actorUserId !== "string" || !facts.actorUserId
        || snapshot.supplements.length > 256 || snapshot.stages.length > 3 || limits?.completeness !== "RECEIVED_SNAPSHOT_ONLY"
        || limits?.freshness !== "UNKNOWN_OFFLINE" || limits?.currentRevocationKnowledge !== "UNAVAILABLE_OFFLINE"
        || JSON.stringify(limits?.excluded) !== JSON.stringify(["UNSEALED_STAGES", "UNSEALED_OBSERVATIONS", "EVIDENCE_BYTES"])) issues.push("UNSUPPORTED_FORMAT");
    if (facts.proofId !== input.expectedProofId || snapshot.proofId !== input.expectedProofId || snapshot.root.proofId !== input.expectedProofId
        || root.proofId !== input.expectedProofId || facts.snapshotId !== snapshot.snapshotId || facts.transactionId !== root.transactionId
        || facts.root?.manifestId !== snapshot.root.manifestId || facts.root?.sha256 !== snapshot.root.sha256) issues.push("ROOT_OR_PROOF_CONTEXT_MISMATCH");
    if (!(facts.tenantId === null || (typeof facts.tenantId === "string" && facts.tenantId.length > 0))) issues.push("INVALID_TENANT_CONTEXT");
    if (input.expectedTenantId && facts.tenantId !== input.expectedTenantId) issues.push(facts.tenantId === null ? "TENANT_BINDING_NOT_ESTABLISHED" : "TENANT_CONTEXT_MISMATCH");
    if (input.expectedSnapshotSha256 && snapshot.sha256 !== input.expectedSnapshotSha256) issues.push("EXPECTED_SNAPSHOT_MISMATCH");
    if (!isTime(facts.createdAt) || !isTime(facts.cutoffAt) || Date.parse(facts.cutoffAt) > Date.parse(facts.createdAt)
        || Date.parse(facts.createdAt) > now.getTime()) issues.push("INVALID_SNAPSHOT_TIME");
    const refs = snapshot.supplements.map(row => ({ supplementId: row.supplementId, sequence: row.sequence, sha256: row.sha256, previousSha256: row.previousSha256 }));
    if (!Array.isArray(facts.supplements) || facts.supplements.length !== refs.length || refs.some((ref, i) => {
      const value = facts.supplements[i];
      return !fieldsAre(value, Object.keys(ref)) || Object.keys(ref).some(field => value[field] !== ref[field as keyof typeof ref]);
    })) issues.push("SUPPLEMENT_INVENTORY_MISMATCH");
    const head = snapshot.supplements.at(-1)?.sha256 ?? snapshot.root.sha256;
    if (facts.watermark?.supplementSequence !== refs.length || facts.watermark?.supplementSha256 !== head) issues.push("SUPPLEMENT_HEAD_MISMATCH");
    if (snapshot.supplements.some(row => !isTime(row.createdAt) || Date.parse(row.createdAt) > Date.parse(facts.cutoffAt))) issues.push("SUPPLEMENT_AFTER_CUTOFF");
    // The existing chain checker preserves legacy exact bytes and root-linked sequence validation.
    const keys = Object.fromEntries((registry?.registry.keys ?? trust.trustList?.keys ?? []).map(key => [key.keyId, key.publicKeyPem]));
    const chain = verifyProofSupplementSnapshot({ proofId: input.expectedProofId, coreManifestSha256: snapshot.root.sha256,
      supplements: snapshot.supplements, trustedPublicKeys: keys, trustSnapshotAt: now.toISOString() });
    issues.push(...chain.issues.filter(issue => !issue.startsWith("INTEGRITY_OR_TRUST_UNCONFIRMED")));
    const ids = new Set<string>(), operations = new Set<string>(), actors = new Map<string, unknown>();
    for (const row of snapshot.supplements) {
      const value = parse(row.canonicalJson), operation = `${String(value.actorUserId)}:${String(value.operationId)}`;
      if (ids.has(row.supplementId) || operations.has(operation) || value.supplementId !== row.supplementId || value.kind !== row.kind
          || !["CORRECTION", "RECIPIENT_RESPONSE", "PARCEL", "CARRIER_UPDATE", "RETURN"].includes(row.kind)
          || typeof value.operationId !== "string" || !value.operationId || !value.facts || typeof value.facts !== "object" || Array.isArray(value.facts)
          || (value.actorUserId !== null && typeof value.actorUserId !== "string")
          || value.attribution !== (value.actorUserId ? "PARTICIPANT_SUPPLIED" : "AUTHORIZED_WORKFLOW")
          || value.recordedAt !== row.createdAt || (value.supersedesSupplementId != null && (row.kind !== "CORRECTION"
          || !actors.has(value.supersedesSupplementId) || actors.get(value.supersedesSupplementId) !== value.actorUserId))) issues.push("SUPPLEMENT_ANCESTRY_MISMATCH");
      ids.add(row.supplementId); operations.add(operation); actors.set(row.supplementId, value.actorUserId);
    }
    if (!Array.isArray(facts.stages) || facts.stages.length !== snapshot.stages.length) issues.push("STAGE_INVENTORY_MISMATCH");
    const seenStages = new Map<string, string>();
    snapshot.stages.forEach((row, index) => {
      const ref = facts.stages?.[index], value = parse(row.canonicalJson);
      if (!fieldsAre(ref, ["stageId", "type", "sha256", "finalizedAt"]) || ref.stageId !== row.stageId || ref.sha256 !== row.sha256 || ref.type !== row.type || ref.finalizedAt !== row.finalizedAt
          || value.stageId !== row.stageId || value.type !== row.type || value.finalizedAt !== row.finalizedAt
          || row.proofId !== input.expectedProofId || value.proofId !== input.expectedProofId || value.baseManifestSha256 !== snapshot.root.sha256
          || sha256Hex(row.canonicalJson) !== row.sha256 || seenStages.has(row.stageId)
          || value.schema !== "packproof.commerce-stage.v1" || !isTime(row.finalizedAt) || Date.parse(row.finalizedAt) > Date.parse(facts.cutoffAt)
          || (value.previousStage && seenStages.get(value.previousStage.stageId) !== value.previousStage.sha256)) issues.push("STAGE_INTEGRITY_OR_ANCESTRY_MISMATCH");
      seenStages.set(row.stageId, row.sha256);
    });
  } catch { issues.push("INVALID_SIGNED_RECORD"); }
  const checks: Array<[string, ReturnType<typeof check>]> = [["SNAPSHOT", snapshotCheck], ["ROOT", rootCheck], ...supplementChecks.map(row => [`SUPPLEMENT:${row.supplementId}`, row] as [string, ReturnType<typeof check>])];
  for (const [label, result] of checks) {
    if (!result.digestValid) issues.push(`${label}:DIGEST_MISMATCH`);
    if (!result.signaturePresent || result.signatureValid !== true) issues.push(`${label}:SIGNATURE_UNCONFIRMED`);
    if (!result.trustedAtSnapshot || !result.trustCurrent) issues.push(`${label}:TRUST_UNCONFIRMED`);
  }
  return { profile: "packproof.lifecycle-verification.v1", snapshotId: snapshot.snapshotId, proofId: snapshot.proofId,
    tenantId, tenantBinding: tenantId == null ? "NOT_ESTABLISHED" : "RECORDED_IN_SIGNED_SNAPSHOT", snapshotSha256: snapshot.sha256, cutoffAt,
    verifiedReceivedSnapshot: issues.length === 0, issues: [...new Set(issues)], root: rootCheck, snapshot: snapshotCheck, supplements: supplementChecks,
    evidenceAvailability: "NOT_CHECKED", availableFileDigests: "NOT_CHECKED", sourceAuthentication: "NOT_INDEPENDENTLY_CHECKED",
    attestationVerification: "NOT_INDEPENDENTLY_CHECKED", policyCoverage: "NOT_EVALUATED", unresolvedConflicts: "NOT_EVALUATED",
    physicalTruthVerified: false, freshness: "UNKNOWN_OFFLINE", currentRevocationKnowledge: "UNAVAILABLE_OFFLINE",
    completeness: "RECEIVED_SNAPSHOT_ONLY" };
}
