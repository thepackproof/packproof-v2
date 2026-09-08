import { sha256Hex } from "../hash.js";
import { DomainError } from "./errors.js";
import type { RecoveryJournalStore } from "./recovery-journal.js";

/** A readable latest object alone cannot back a receipt that must survive recovery. */
export async function verifyPreservedJournalVersion(
  store: RecoveryJournalStore,
  objectKey: string,
  expectedBytes: Buffer,
  conflictCode: "RECOVERY_ENVELOPE_CONFLICT" | "POLICY_ENVELOPE_CONFLICT",
): Promise<string> {
  const head = await store.head?.(objectKey);
  const versionId = head?.versionId;
  if (typeof versionId !== "string" || !versionId.trim() || versionId === "null") {
    throw new DomainError("RECOVERY_OBJECT_VERSION_REQUIRED", "The preserved journal must expose an exact retained object version", 503);
  }
  const exact = await store.get(objectKey, { versionId });
  if (!exact) {
    throw new DomainError("RECOVERY_OBJECT_VERSION_UNAVAILABLE", "The exact preserved journal version is unavailable", 503);
  }
  if (sha256Hex(exact.body) !== sha256Hex(expectedBytes)) {
    throw new DomainError(conflictCode, "The retained journal version differs from the authenticated envelope", 503);
  }
  return versionId;
}
