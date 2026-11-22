import type { Configuration, ConnectStatus } from './types';
/** Internal checkpoints are retained for safe resume. Operators only see three stages. */
export const STEPS = ['Welcome', 'Computer check', 'Workspace', 'Export source', 'Field mapping', 'First import', 'Automatic collection'] as const;
export const GUIDED_STAGES = ['Connect your source', 'Review a shipment', 'Start collecting'] as const;
export function guidedStage(step: number): 0 | 1 | 2 {
  if (step <= 3) return 0;
  if (step === 4) return 1;
  return 2;
}
// Suggestions are only candidates. Service analysis of original bytes is the
// readiness boundary; header matches must never be counted as validated fields.
import { CSV_RULES, headerKey } from '../../backend/src/records/csv-semantics';
export function suggestMapping(headers:string[]):Record<string,string>{
 const mapping:Record<string,string>={};
 for(const [field,names] of Object.entries(CSV_RULES.aliases)){
  const matches=headers.filter(h=>(names as string[]).includes(headerKey(h)));
  if(matches.length===1)mapping[field]=matches[0];
 }
 return mapping;
}
const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])):value;
export function configKey(config:Configuration|undefined):string{return config?JSON.stringify(stable(config)):'';}
export function previewValid(status: ConnectStatus): boolean {
  const counts = status.preview?.counts;
  return !!counts && (counts.valid > 0) && !counts.duplicate && !counts.invalid && !counts.ambiguous && !counts.failed;
}
export function accessUnavailable(status: ConnectStatus): boolean {
  return status.state === 'revoked' || status.state === 'permission_required'
    || status.transport?.state === 'forbidden' || status.transport?.state === 'unauthenticated';
}
export function verificationCurrent(status: ConnectStatus, draft: Configuration | undefined, dirty: boolean): boolean {
  return !accessUnavailable(status) && !dirty && !status.pendingProposal && !!status.verification?.complete && !!status.verification.recordId && configKey(draft) === configKey(status.config)
    && typeof status.configRevision === 'number' && status.verification.configRevision === status.configRevision
    && !!status.source?.fileSha256 && status.verification.fileSha256 === status.source.fileSha256;
}
/** A stale cloud proposal can coexist with a newly read local draft until the operator submits it. */
export function pendingCsvReview(status: ConnectStatus | null, now: number): 'current' | 'expired' | 'reread' {
  const pending = status?.pendingProposal?.sourceContract;
  if (!status || pending?.schema !== 'packproof.scheduled-csv/v2' || status.preview) return 'current';
  const windowMs = 30 * 60 * 1000;
  const observed = Date.parse(pending.historyPolicy?.observedAt ?? '');
  if (Number.isFinite(observed) && now <= observed + windowMs) return 'current';
  const draft = status.analysis;
  const local = draft?.configuration.sourceContract;
  const reread = Date.parse(local?.historyPolicy?.observedAt ?? '');
  if (draft && local?.schema === 'packproof.scheduled-csv/v2' && local.historyPolicy
      && Number.isFinite(reread) && reread <= now && now <= reread + windowMs
      && (!Number.isFinite(observed) || reread > observed)
      && draft.binding.sourceBindingId === status.installationId
      && draft.binding.folderDigest === status.source?.folderDigest
      && draft.binding.fileSha256 === status.source?.fileSha256
      && local.historyPolicy.initialFileSha256 === draft.binding.fileSha256
      && local.historyPolicy.initialFileName === status.source?.selectedFileName) return 'reread';
  return 'expired';
}
export function resumeStep(status: ConnectStatus): number {
  if (pendingCsvReview(status, Date.now()) === 'reread') return 4;
  if(status.setup?.running||status.pendingProposal)return 5;
  if (['active', 'paused'].includes(status.state)) return 6;
  if (status.preview) return 5;
  if (status.source?.accessible) return status.source.headers?.length ? 4 : 3;
  if (status.installationId) return 3;
  if (status.enrollment) return 2;
  return 0;
}
