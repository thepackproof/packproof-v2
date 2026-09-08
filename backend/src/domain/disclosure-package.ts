import { Readable } from "node:stream";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import type { ObjectStore } from "../s3/object-store.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { collectSmallZip, streamZip, zipBytes, ZipStreamError, type ZipStreamEntry } from "../export/zip-stream.js";
import { DomainError } from "./errors.js";
import { assertDisclosureMedia, getDisclosureProjection, resolveDisclosureContext } from "./disclosure.js";
import { readDisclosedMediaStream } from "./disclosure-stream.js";

/** Small compatibility helper; HTTP routes must use the bounded stream below. */
export async function exportDisclosurePackage(db: Database, clock: Clock, store: ObjectStore, token: string): Promise<Buffer> {
  return collectSmallZip(await exportDisclosurePackageStream(db, clock, store, token));
}

/** An explicitly scoped view. Media is never accumulated into a whole-file or ZIP buffer. */
export async function exportDisclosurePackageStream(db: Database, clock: Clock, store: ObjectStore, token: string,
  options: { maximumMediaBytes?: number } = {}): Promise<Readable> {
  const maximumMediaBytes = options.maximumMediaBytes ?? 200 * 1024 * 1024;
  if (!Number.isSafeInteger(maximumMediaBytes) || maximumMediaBytes < 0 || maximumMediaBytes > 200 * 1024 * 1024) throw tooLarge();
  const context = await resolveDisclosureContext(db, clock, { token });
  const projection = await getDisclosureProjection(db, context), declared = new Map<string, number>();
  if (projection.evidence.length > 1000) throw tooLarge();
  let plannedBytes = 0;
  // Reject cumulative oversize using authorized metadata before opening an object stream.
  for (const selected of projection.evidence) {
    const selection = assertDisclosureMedia(context, selected.evidenceId, selected.derivativeId ?? undefined);
    let row: { byte_size: string | number } | undefined;
    if (selection.representation === "DERIVATIVE") {
      row = (await db.query<{ byte_size: string | number }>("SELECT d.byte_size FROM proof_media_derivatives d JOIN evidence e ON e.id=d.evidence_id AND e.proof_id=d.proof_id AND e.sha256=d.source_sha256 WHERE d.id=$1 AND d.proof_id=$2 AND d.evidence_id=$3 AND d.status='REVIEWED'", [selection.derivativeId, context.proofId, selected.evidenceId])).rows[0];
    } else {
      row = (await db.query<{ byte_size: string | number }>("SELECT byte_size FROM evidence WHERE id=$1 AND proof_id=$2 AND validation_status='COMMITTED'", [selected.evidenceId, context.proofId])).rows[0];
      if (!row && context.purpose === "SHARED_PROOF") row = (await db.query<{ byte_size: string | number }>("SELECT e.byte_size FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id WHERE e.id=$1 AND s.proof_id=$2 AND e.committed_at IS NOT NULL AND e.discarded_at IS NULL", [selected.evidenceId, context.proofId])).rows[0];
    }
    const size = Number(row?.byte_size);
    if (!row || !Number.isSafeInteger(size) || size < 0) throw new DomainError("EVIDENCE_NOT_FOUND", "Selected source is unavailable", 404);
    if ((plannedBytes += size) > maximumMediaBytes) throw tooLarge();
    declared.set(selected.evidenceId, size);
  }
  const projectionBytes = Buffer.from(canonicalize(projection));
  if (projectionBytes.length > 8 * 1024 * 1024) throw tooLarge();
  async function authorizeSnapshot() {
    const active = await resolveDisclosureContext(db, clock, { token });
    if (active.proofId !== context.proofId || active.scopeVersion !== context.scopeVersion || active.grantId !== context.grantId
        || active.scopeIdentity !== context.scopeIdentity || canonicalize(active.fields) !== canonicalize(context.fields))
      throw new DomainError("INSUFFICIENT_SCOPE", "The recipient view changed; reopen the shared link", 403);
    for (const selected of projection.evidence) assertDisclosureMedia(active, selected.evidenceId, selected.derivativeId ?? undefined);
  }
  await authorizeSnapshot();
  async function* entries(): AsyncGenerator<ZipStreamEntry> {
    const hashes: Record<string, string> = {}, media: Array<Record<string, unknown>> = [];
    const json = (name: string, value: unknown) => {
      const bytes = Buffer.from(canonicalize(value)); if (bytes.length > 8 * 1024 * 1024) throw tooLarge();
      hashes[name] = sha256Hex(bytes); return zipBytes(name, bytes);
    };
    for (const selected of projection.evidence) {
      await authorizeSnapshot();
      const source = await readDisclosedMediaStream(db, clock, store, token, selected.evidenceId);
      try {
        if (!source.body || source.status !== 200 || source.byteSize !== declared.get(selected.evidenceId))
          throw new DomainError("EVIDENCE_INTEGRITY_FAILURE", "Selected media metadata changed during export", 409);
        const name = `media/${selected.evidenceId}.bin`;
        yield { name, body: source.body, byteSize: source.byteSize, sha256: source.sha256, onComplete: result => {
          hashes[name] = result.sha256;
          // Only the selected representation's digest is included. Hidden original lineage stays withheld.
          media.push({ evidenceId: selected.evidenceId, representation: selected.representation, derivativeId: selected.derivativeId,
            path: name, contentType: source.contentType, byteSize: result.byteSize, sha256: result.sha256,
            lineage: selected.representation === "DERIVATIVE" ? "SOURCE_WITHHELD_BY_SCOPE" : "ORIGINAL_AS_AUTHORIZED_BY_GRANT" });
        } };
      } finally { source.body?.destroy(); }
    }
    hashes["view.json"] = sha256Hex(projectionBytes); yield zipBytes("view.json", projectionBytes);
    yield json("package.json", {
      schema: "packproof.disclosure-package.v1", proofId: context.proofId, exportedAt: clock.now().toISOString(),
      disclosure: projection.disclosure, projectionSha256: sha256Hex(projectionBytes), media,
      omissions: ["Canonical manifest and unselected fields/media are withheld by scope"],
      integrity: "DISCLOSURE_SELF_CONSISTENCY_ONLY", signature: null,
      limitations: ["This is a recipient view, not the complete canonical record", "Excluded originals have not been verified", "Revocation cannot recall an exported file"],
    });
    yield zipBytes("integrity/hashes.json", Buffer.from(canonicalize(hashes)));
  }
  // Checks precede every <=64KiB emitted chunk, including metadata and the end directory.
  const zip = streamZip(entries(), { beforeChunk: authorizeSnapshot });
  return Readable.from((async function* () {
    try { for await (const chunk of zip) yield chunk; }
    catch (error) { if (error instanceof ZipStreamError) throw error.code === "ZIP_TOO_LARGE" ? tooLarge() : new DomainError("EVIDENCE_INTEGRITY_FAILURE", error.message, 409); throw error; }
    finally { zip.destroy(); }
  })(), { objectMode: false, highWaterMark: 64 * 1024 });
}
function tooLarge() { return new DomainError("PACKAGE_TOO_LARGE", "This view exceeds the bounded package limit; download individual sources", 413); }
