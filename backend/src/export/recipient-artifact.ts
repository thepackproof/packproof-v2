import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { DomainError } from '../domain/errors.js';
import type { Artifact, ExportRequest, Job } from '../domain/recipient-exports.js';
import type { SignatureCasePreview } from '../domain/signature.js';
import type { ProtectedReceipt } from '../integrity/envelope-jobs.js';
import { validateRecipientFiles } from './recipient-profiles.js';
import { RECIPIENT_ARTIFACT_MAX_BYTES, validateRecipientReceipt, type RecipientArtifactReader } from './recipient-preservation.js';

const fail = () => new DomainError('EXPORT_ARTIFACT_CONFLICT', 'The protected artifact does not match its accepted request and sources.', 409);
const same = (a: unknown, b: unknown) => canonicalize(a ?? null) === canonicalize(b ?? null);
/** Reused for first-winner reconciliation, API reads and fresh-target recovery.
 * Exact preserved output is verified here; no rendering or signing is performed. */
export async function verifyRecipientArtifact(input: {
  job: Pick<Job, 'id' | 'proof_id' | 'case_id' | 'request_json' | 'request_sha256'>;
  preview: SignatureCasePreview;
  bytes: Buffer;
  receipt: ProtectedReceipt;
  reader: RecipientArtifactReader;
  beforeRead?: () => Promise<void>;
}) {
  const { job, preview: p, bytes, reader, receipt } = input;
  if (bytes.length > RECIPIENT_ARTIFACT_MAX_BYTES || sha256Hex(job.request_json) !== job.request_sha256) throw fail();
  const r = JSON.parse(job.request_json) as ExportRequest, a = JSON.parse(bytes.toString('utf8')) as Artifact;
  if (!r.preservation || !r.claimCase || canonicalize(a) !== bytes.toString('utf8') || a.schema !== 'packproof.recipient-export.v2' ||
      a.jobId !== job.id || a.proofId !== job.proof_id || a.caseId !== job.case_id || a.caseId !== r.caseId || a.caseSha256 !== r.caseSha256 ||
      a.requestSha256 !== job.request_sha256 || !same(a.preservation, r.preservation) || !same(a.claimCase, r.claimCase) || !same(a.claimSelection, r.claimSelection) ||
      !same(a.profile, r.profile) || a.approvedNarrative !== r.narrative || a.scope !== r.scopeStatement || a.destinationDeadline !== r.destinationDeadline ||
      a.snapshotId !== p.snapshotId || a.snapshotSha256 !== p.snapshotSha256 || a.manifestSha256 !== p.coreManifestSha256 || !same(a.recordAsOf, p.recordAsOf) ||
      p.proofId !== job.proof_id || sha256Hex(canonicalize(p)) !== r.caseSha256 || !Array.isArray(a.files) || !Array.isArray(a.sources) || a.sources.length !== r.frames.length ||
      a.portalAcceptance !== 'NOT_TESTED' || a.submission !== 'MERCHANT_CONTROLLED' || !Number.isFinite(Date.parse(a.createdAt))) throw fail();
  validateRecipientReceipt(job.id, receipt, r.preservation, true);
  if (receipt.sha256 !== sha256Hex(bytes) || receipt.byteSize !== bytes.length) throw fail();
  await input.beforeRead?.();
  if (!(await reader.read(job.id, receipt, r.preservation)).equals(bytes)) throw fail();
  const output: Buffer[] = [], names = new Set<string>();
  for (const f of a.files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(f.name) || f.name.includes('..') || names.has(f.name) || !f.preservation) throw fail();
    names.add(f.name); validateRecipientReceipt(job.id, f.preservation, r.preservation);
    if (f.sha256 !== f.preservation.sha256 || f.byteSize !== f.preservation.byteSize || f.objectKey !== f.preservation.object.key) throw fail();
    await input.beforeRead?.(); output.push(await reader.read(job.id, f.preservation, r.preservation));
  }
  const checked = validateRecipientFiles(r.profile, a.files.map((f, i) => ({ ...f, bytes: output[i] })));
  if (checked.bytes > r.profile.targetBytes) throw fail();
  for (const [i, source] of a.sources.entries()) {
    const frame = r.frames[i], original = p.evidence.find(row => row.evidenceId === frame.evidenceId);
    if (!original || source.evidenceId !== frame.evidenceId || source.requestedOffsetMs !== frame.offsetMs || source.sourceSha256 !== original.sha256 ||
        source.sourceCommittedAt !== original.committedAt || !source.sourceActorUserId || source.actorAttribution !== 'AUTHENTICATED_SUBMITTER' ||
        !Number.isSafeInteger(source.presentationTimestampMs) || source.presentationTimestampMs < frame.offsetMs - 1 ||
        !source.originalFramePreservation || !source.derivedFilePreservation) throw fail();
    for (const [saved, digest, key] of [[source.originalFramePreservation, source.originalFrameSha256, source.originalFrameObjectKey],
      [source.derivedFilePreservation, source.derivedFileSha256, source.derivedFileObjectKey]] as const) {
      validateRecipientReceipt(job.id, saved, r.preservation);
      if (saved.sha256 !== digest || saved.object.key !== key) throw fail();
      await input.beforeRead?.(); await reader.read(job.id, saved, r.preservation);
    }
  }
  await input.beforeRead?.();
  return { artifact: a, files: output };
}
