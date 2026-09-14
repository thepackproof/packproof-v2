import { sha256 } from '@noble/hashes/sha256';
import { canonicalize } from '../../../backend/src/canonical';

export const CASE_FIELDS = ['status', 'order', 'shipping', 'evidence', 'statements'] as const;
export type CaseField = typeof CASE_FIELDS[number];
export const digestBytes = (value: Uint8Array) => Array.from(sha256(value), byte => byte.toString(16).padStart(2, '0')).join('');
export const digestValue = (value: unknown) => Array.from(sha256(canonicalize(value)), byte => byte.toString(16).padStart(2, '0')).join('');
const hashPattern = /^[a-f0-9]{64}$/;
const identifier = /^[A-Za-z0-9_-]{1,200}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function assertCurrent(current: () => boolean): void {
  if (!current()) throw new Error('This account or Proof changed. Open the original Proof to continue.');
}
export async function scoped<T>(current: () => boolean, action: () => Promise<T>): Promise<T> {
  assertCurrent(current);
  const result = await action();
  assertCurrent(current);
  return result;
}
export function caseScope(fields: readonly string[], evidenceIds: readonly string[], availableIds: readonly string[]) {
  if (fields.some(field => !CASE_FIELDS.includes(field as CaseField))) throw new Error('Choose only the documented packet fields.');
  if (evidenceIds.some(id => !availableIds.includes(id))) throw new Error('A selected source is no longer in this snapshot.');
  return { fields: [...new Set(fields)], evidenceIds: fields.includes('evidence') ? [...new Set(evidenceIds)] : [] };
}

export type HistoryEntry = { linkId: string; state: string; previousProofId?: string; proofId?: string; note?: string; reason?: string; events?: Array<{ eventId: string; state: string; note: string; createdAt: string }> };
export type ItemHistory = { optedIn: boolean; entries: HistoryEntry[]; limitations?: string[] };
export type HistoryPreview = { proofId: string; recipientUserId: string; linkIds: string[]; entries: HistoryEntry[]; limitations: string[]; [key: string]: unknown };
export type ReviewedHistory = { preview: HistoryPreview; previewSha256: string };
function historyEntries(value: unknown): value is HistoryEntry[] {
  return Array.isArray(value) && value.every(entry => object(entry) && typeof entry.linkId === 'string' && typeof entry.state === 'string' &&
    ['note', 'reason', 'proofId', 'previousProofId'].every(key => entry[key] === undefined || typeof entry[key] === 'string') &&
    (entry.events === undefined || Array.isArray(entry.events) && entry.events.every(event => object(event) && ['eventId', 'state', 'note', 'createdAt'].every(key => typeof event[key] === 'string'))));
}
export function historyFrom(value: unknown): ItemHistory {
  if (!object(value) || typeof value.optedIn !== 'boolean' || !historyEntries(value.entries) || (value.limitations !== undefined && (!Array.isArray(value.limitations) || value.limitations.some(limit => typeof limit !== 'string')))) throw new Error('Item history could not be read. Refresh this Proof.');
  return value as ItemHistory;
}
export function incomingHistoryFrom(value: unknown, proofId: string): { preview: HistoryPreview; changedSinceApproval: boolean } {
  if (!object(value) || !object(value.preview) || value.preview.proofId !== proofId || !historyEntries(value.preview.entries) || !Array.isArray(value.preview.limitations) || value.preview.limitations.some(limit => typeof limit !== 'string') || typeof value.changedSinceApproval !== 'boolean') throw new Error('This history selection belongs to a different Proof or could not be read.');
  return value as { preview: HistoryPreview; changedSinceApproval: boolean };
}
export function historyApprovalBody(value: ReviewedHistory, proofId: string, recipientUserId: string, linkIds: string[]) {
  const sorted = [...new Set(linkIds)].sort();
  if (!value?.preview || !Array.isArray(value.preview.linkIds) || !historyEntries(value.preview.entries) || !Array.isArray(value.preview.limitations) || value.preview.limitations.some(limit => typeof limit !== 'string') || !sorted.length || sorted.length > 25 || value.preview.proofId !== proofId || value.preview.recipientUserId !== recipientUserId || canonicalize([...value.preview.linkIds].sort()) !== canonicalize(sorted) || canonicalize(value.preview.entries.map(entry => entry.linkId).sort()) !== canonicalize(sorted) || value.preview.entries.some(entry => entry.state === 'UNAVAILABLE') || !hashPattern.test(value.previewSha256) || digestValue(value.preview) !== value.previewSha256) throw new Error('The selected history changed. Review a fresh recipient preview before sharing.');
  return { recipientUserId, linkIds: sorted, previewSha256: value.previewSha256 };
}
export function historyShareId(input: string, proofId: string): string {
  const trimmed = input.trim();
  if (identifier.test(trimmed)) return trimmed;
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error('Paste a PackProof history link or its handoff identifier.'); }
  const id = url.searchParams.get('historyShare');
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !['thepackproof.com', 'www.thepackproof.com'].includes(url.hostname) || url.pathname !== `/proofs/${encodeURIComponent(proofId)}` || url.searchParams.getAll('historyShare').length !== 1 || !id || !identifier.test(id)) throw new Error('Open the PackProof history link for this exact Proof.');
  return id;
}
export async function approveHistorySelection(input: { reviewed: ReviewedHistory; proofId: string; recipientUserId: string; linkIds: string[]; current: () => boolean; create: (body: ReturnType<typeof historyApprovalBody>) => Promise<unknown> }): Promise<{ shareId: string; path: string }> {
  const body = historyApprovalBody(input.reviewed, input.proofId, input.recipientUserId, input.linkIds);
  const response = await scoped(input.current, () => input.create(body));
  if (!object(response) || typeof response.path !== 'string' || typeof response.shareId !== 'string' || historyShareId(`https://thepackproof.com${response.path}`, input.proofId) !== response.shareId) throw new Error('The approved handoff could not be verified.');
  return { shareId: response.shareId, path: response.path };
}

export type RecipientProfile = { id: string; destination: 'EBAY_PAYMENT_DISPUTE' | 'STRIPE_DISPUTE'; network: string; region: string; version: string; reviewRequired: boolean };
export type RecipientFile = { name: string; contentType: string; byteSize: number; sha256: string };
export type RecipientJob = { jobId: string; proofId: string; caseId: string; state: 'QUEUED' | 'RENDERING' | 'READY' | 'FAILED'; artifactSha256: string | null; failureCode: string | null; approval?: { artifactSha256: string; actorUserId: string; approvedAt: string } | null; artifact?: { files: RecipientFile[]; approvedNarrative: string; gaps: string[]; [key: string]: unknown } | null };
export type RecipientFrame = { evidenceId: string; seconds: string; label: string };
export type VerifiedPreview = RecipientFile & { uri: string; viewed: boolean };
export function profilesFrom(value: unknown): RecipientProfile[] {
  if (!object(value) || !Array.isArray(value.profiles) || value.profiles.length > 20 || value.profiles.some(p => !object(p) || typeof p.id !== 'string' || !p.id || typeof p.version !== 'string' || typeof p.reviewRequired !== 'boolean' || !['EBAY_PAYMENT_DISPUTE', 'STRIPE_DISPUTE'].includes(String(p.destination)) || typeof p.network !== 'string' || typeof p.region !== 'string') || new Set(value.profiles.map(p => p.id)).size !== value.profiles.length) throw new Error('Submission formats could not be read. Reload formats to try again.');
  return value.profiles as RecipientProfile[];
}
export function recipientJobFrom(value: unknown, proofId: string, caseId: string): RecipientJob {
  const invalid = () => new Error('Preparation belongs to a different record or could not be verified. Check preparation again.');
  if (!object(value) || typeof value.jobId !== 'string' || !identifier.test(value.jobId) || value.proofId !== proofId || value.caseId !== caseId || !['QUEUED', 'RENDERING', 'READY', 'FAILED'].includes(String(value.state))) throw invalid();
  if (value.state === 'READY') {
    const artifact = value.artifact;
    if (typeof value.artifactSha256 !== 'string' || !hashPattern.test(value.artifactSha256) || !object(artifact) || artifact.proofId !== proofId || artifact.caseId !== caseId || artifact.jobId !== value.jobId || !Array.isArray(artifact.files) || !artifact.files.length || artifact.files.length > 5 || typeof artifact.approvedNarrative !== 'string' || !Array.isArray(artifact.gaps) || artifact.gaps.some(g => typeof g !== 'string') || digestValue(artifact) !== value.artifactSha256) throw invalid();
    if (artifact.files.some(file => !object(file) || typeof file.name !== 'string' || !/^[A-Za-z0-9_-]+\.(pdf|jpg|jpeg|png)$/.test(file.name) || !(['application/pdf', 'image/jpeg', 'image/png'].includes(String(file.contentType))) || (file.contentType === 'application/pdf' ? !file.name.endsWith('.pdf') : file.contentType === 'image/png' ? !file.name.endsWith('.png') : !/\.jpe?g$/.test(file.name)) || !Number.isSafeInteger(file.byteSize) || Number(file.byteSize) < 1 || Number(file.byteSize) > 4_500_000 || typeof file.sha256 !== 'string' || !hashPattern.test(file.sha256)) || new Set(artifact.files.map(f => f.name)).size !== artifact.files.length) throw invalid();
    if (value.approval != null && (!object(value.approval) || value.approval.artifactSha256 !== value.artifactSha256 || typeof value.approval.actorUserId !== 'string' || typeof value.approval.approvedAt !== 'string')) throw invalid();
  } else if (value.approval != null) throw invalid();
  return value as RecipientJob;
}
export function recipientRequest(input: { caseId: string; profile: RecipientProfile | undefined; frames: RecipientFrame[]; sourceIds: string[]; narrative: string; deadline: string; instructionsReviewed: boolean; idempotencyKey: string }, now = Date.now()) {
  if (!input.profile || input.profile.reviewRequired) throw new Error('Choose a currently reviewed destination format.');
  if (!input.instructionsReviewed || !Number.isFinite(Date.parse(input.deadline)) || Date.parse(input.deadline) <= now) throw new Error('Check the actual case instructions and enter its future submission deadline.');
  if (!input.frames.length || input.frames.length > 4 || input.frames.some(f => !input.sourceIds.includes(f.evidenceId) || !f.seconds.trim() || !Number.isFinite(Number(f.seconds)) || Number(f.seconds) < 0 || Number(f.seconds) > 21600 || !f.label.trim() || f.label.length > 120) || input.narrative.length > 2000) throw new Error('Select up to four included source frames, each with a valid time and a factual label.');
  return { caseId: input.caseId, profileId: input.profile.id, frames: input.frames.map(f => ({ evidenceId: f.evidenceId, offsetMs: Math.round(Number(f.seconds) * 1000), label: f.label.trim() })), narrative: input.narrative, destinationDeadline: new Date(input.deadline).toISOString(), destinationInstructionsReviewed: true, idempotencyKey: input.idempotencyKey };
}
export function verifyRecipientBytes(bytes: Uint8Array, file: RecipientFile): void {
  if (bytes.length !== file.byteSize || digestBytes(bytes) !== file.sha256) throw new Error('This preview does not match the exact prepared file. Reload it before approving.');
}
export function recipientApprovalBody(job: RecipientJob, previews: VerifiedPreview[], legible: boolean) {
  if (job.state !== 'READY' || !job.artifact || !job.artifactSha256 || !legible || previews.length !== job.artifact.files.length || job.artifact.files.some(file => !previews.some(p => p.name === file.name && p.sha256 === file.sha256 && p.byteSize === file.byteSize && p.viewed))) throw new Error('Open every exact prepared file and confirm the relevant details are readable before approving.');
  return { artifactSha256: job.artifactSha256, legibilityConfirmed: true };
}
export async function approveRecipientPreparation(input: { job: RecipientJob; previews: VerifiedPreview[]; legible: boolean; userId: string; current: () => boolean; approve: (jobId: string, body: ReturnType<typeof recipientApprovalBody>) => Promise<unknown> }): Promise<RecipientJob> {
  assertCurrent(input.current);
  const original = recipientJobFrom(input.job, input.job.proofId, input.job.caseId);
  const approved = original.approval ? original : recipientJobFrom(await scoped(input.current, () => input.approve(original.jobId, recipientApprovalBody(original, input.previews, input.legible))), original.proofId, original.caseId);
  if (approved.jobId !== original.jobId || approved.artifactSha256 !== original.artifactSha256 || approved.approval?.actorUserId !== input.userId) throw new Error('Approval was not confirmed for these exact files and this account.');
  assertCurrent(input.current);
  return approved;
}
export function recipientFailure(code: string | null) {
  if (code === 'EXPORT_SOURCE_RESOLUTION') return 'The source frame is too small for readable submission files. Choose a higher-resolution recording.';
  if (['EXPORT_BYTE_LIMIT', 'EXPORT_PAGE_LIMIT', 'EXPORT_FILE_COUNT_LIMIT', 'EXPORT_RELEVANCE_REQUIRED'].includes(code ?? '')) return 'This selection cannot fit the destination limits legibly. Choose fewer relevant frames or shorter text.';
  if (code === 'EXPORT_PROFILE_STALE') return 'This destination format needs an updated review before new files can be prepared.';
  return 'The files could not be prepared. Review the source selection or try again when preparation is available.';
}
