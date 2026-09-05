import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import type { ObjectStore } from "../s3/object-store.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { zipFiles } from "../export/zip.js";
import { DomainError } from "./errors.js";
import { getDisclosureProjection, readDisclosedMedia, resolveDisclosureContext } from "./disclosure.js";

/** An explicitly scoped view, never a replacement canonical Proof package. */
export async function exportDisclosurePackage(db: Database, clock: Clock, store: ObjectStore, token: string): Promise<Buffer> {
  const context = await resolveDisclosureContext(db, clock, { token });
  const projection = await getDisclosureProjection(db, context);
  const files: Array<{ name: string; bytes: Buffer }> = [];
  const json = (name: string, value: unknown) => files.push({ name, bytes: Buffer.from(canonicalize(value)) });
  const media = [];
  let totalBytes = 0;
  for (const selected of projection.evidence) {
    const authorized = await readDisclosedMedia(db, clock, store, token, selected.evidenceId);
    totalBytes += authorized.body.length;
    if (totalBytes > 200 * 1024 * 1024) throw new DomainError("PACKAGE_TOO_LARGE", "This view exceeds the 200 MB package limit", 413);
    const name = `media/${selected.evidenceId}.bin`;
    files.push({ name, bytes: authorized.body });
    // Do not disclose object keys, original hashes, raw transform instructions, or source manifests.
    // A recipient can verify included bytes but cannot verify the withheld original lineage offline.
    media.push({ evidenceId: selected.evidenceId, representation: selected.representation, derivativeId: selected.derivativeId,
      path: name, contentType: authorized.contentType, byteSize: authorized.body.length, sha256: sha256Hex(authorized.body),
      lineage: selected.representation === "DERIVATIVE" ? "SOURCE_WITHHELD_BY_SCOPE" : "ORIGINAL_AS_AUTHORIZED_BY_GRANT" });
  }
  json("view.json", projection);
  json("package.json", {
    schema: "packproof.disclosure-package.v1",
    proofId: context.proofId,
    exportedAt: clock.now().toISOString(),
    disclosure: projection.disclosure,
    projectionSha256: sha256Hex(canonicalize(projection)),
    media,
    omissions: ["Canonical manifest and unselected fields/media are withheld by scope"],
    integrity: "DISCLOSURE_SELF_CONSISTENCY_ONLY",
    signature: null,
    limitations: ["This is a recipient view, not the complete canonical record", "Excluded originals have not been verified", "Revocation cannot recall an exported file"],
  });
  json("integrity/hashes.json", Object.fromEntries(files.map(file => [file.name, sha256Hex(file.bytes)])));
  const latest = await resolveDisclosureContext(db, clock, { token });
  if (latest.scopeVersion !== context.scopeVersion || latest.grantId !== context.grantId || latest.scopeIdentity !== context.scopeIdentity)
    throw new DomainError("INSUFFICIENT_SCOPE", "The recipient view changed; reopen the shared link", 403);
  return zipFiles(files);
}
