import type { OnboardingState } from '../../../packages/onboarding/model';
import type { TransactionWriteInput } from '../api/types';

/** A build selects the shell once. Never switch it while a task is in flight. */
export const firstProofExperienceEnabled = () => import.meta.env.VITE_PACKPROOF_FIRST_PROOF_EXPERIENCE === 'true';
export const FIRST_PROOF_FLOW_VERSION = 1;
export type ExperienceState = OnboardingState | null;

export function draftStorageKey(apiScope: string, userId: string, reference = '') {
  return `packproof:first-proof:draft:v1:${JSON.stringify([apiScope, userId, reference])}`;
}

export function readDraft<T>(key: string | undefined): Partial<T> | null {
  if (!key) return null;
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value && value.version === 1 && value.fields && typeof value.fields === 'object' ? value.fields : null;
  } catch { return null; }
}

export function saveDraft(key: string | undefined, fields: unknown): boolean {
  if (!key) return false;
  try { localStorage.setItem(key, JSON.stringify({ version: 1, fields })); return true; }
  catch { return false; }
}

export function clearDraft(key: string) {
  try { localStorage.removeItem(key); } catch { /* A storage failure never changes server state. */ }
}

type CreationOperation = {version:1;id:string;request?:TransactionWriteInput};
function readCreationOperation(key:string):CreationOperation|null {
  const saved=localStorage.getItem(`${key}:operation`);
  if(!saved)return null;
  // Keep operations saved by the compatible shell/recovery path usable.
  if(/^[a-zA-Z0-9_-]{8,120}$/.test(saved))return {version:1,id:saved};
  const parsed=JSON.parse(saved) as CreationOperation;
  if(parsed?.version!==1||typeof parsed.id!=='string'||!/^[a-zA-Z0-9_-]{8,120}$/.test(parsed.id))
    throw new Error('This browser could not read the pending creation. Check your Proofs before starting another.');
  if(parsed.request&&(typeof parsed.request!=='object'||Array.isArray(parsed.request)))
    throw new Error('This browser could not read the submitted details. Check your Proofs before starting another.');
  return parsed;
}
function canonicalRequest(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonicalRequest);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,nested])=>nested!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([name,nested])=>[name,canonicalRequest(nested)]));
  return value;
}
export function sameCreationRequest(left:TransactionWriteInput,right:TransactionWriteInput) {
  return JSON.stringify(canonicalRequest(left))===JSON.stringify(canonicalRequest(right));
}
export function pendingCreationRequest(key:string|undefined):TransactionWriteInput|null {
  if(!key)return null;
  try{return readCreationOperation(key)?.request??null;}catch{return null;}
}
/** Persist the key and exact submitted fields before sending. A response-loss
 * retry must never substitute newer form edits into the same creation. */
export function creationOperation(key: string, request?:TransactionWriteInput) {
  const storageKey = `${key}:operation`;
  const saved=readCreationOperation(key);
  if(saved?.request&&request&&!sameCreationRequest(saved.request,request))
    throw new Error('A previous creation request is still pending. Recover the submitted draft before changing its details.');
  if(saved&&(!request||saved.request))return saved.id;
  const operation:CreationOperation=saved??{version:1,id:crypto.randomUUID()};
  if(request&&!operation.request)operation.request=request;
  localStorage.setItem(storageKey,JSON.stringify(operation));
  return operation.id;
}

/** Use only for a definite transaction-creation validation rejection. Never
 * release an operation after a timeout, lost response, or downstream failure. */
export function rejectCreationValidation(key:string) {
  try{localStorage.removeItem(`${key}:operation`);}catch{/* Preserve retry identity if storage is unavailable. */}
}

export function completeCreation(key: string) {
  clearDraft(key);
  try { localStorage.removeItem(`${key}:operation`); } catch { /* Same operation safely reopens its Proof. */ }
}
