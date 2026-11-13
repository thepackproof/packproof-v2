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
export function verificationCurrent(status: ConnectStatus, draft: Configuration | undefined, dirty: boolean): boolean {
  return status.state !== 'revoked' && !dirty && !status.pendingProposal && !!status.verification?.complete && !!status.verification.recordId && configKey(draft) === configKey(status.config)
    && typeof status.configRevision === 'number' && status.verification.configRevision === status.configRevision
    && !!status.source?.fileSha256 && status.verification.fileSha256 === status.source.fileSha256;
}
export function resumeStep(status: ConnectStatus): number {
  if(status.setup?.running||status.pendingProposal)return 5;
  if (['active', 'paused'].includes(status.state)) return 6;
  if (status.preview) return 5;
  if (status.source?.accessible) return status.source.headers?.length ? 4 : 3;
  if (status.installationId) return 3;
  if (status.enrollment) return 2;
  return 0;
}
