/** A receipt is a projection of matching server records, never an upload percentage. */
type ReceiptOperation = { status: string; receipt: unknown };
type ReceiptProof = { proofId: string; status: string; finalizedAt: string | null; evidence: Array<{evidenceId:string;validationStatus:string}> };
export type SignalRecovery = { proofId:string; evidence:Array<ReceiptOperation & {evidenceId:string}>; finalization:ReceiptOperation };
export function isDurableSignalOperation(operation: ReceiptOperation | undefined): boolean {
  const receipt=operation?.receipt as Record<string,unknown>|null;
  return operation?.status==='PRESERVED' && !!receipt && ['operationId','eventSha256','envelopeSha256','preservedAt'].every(key=>typeof receipt[key]==='string' && !!receipt[key]) && !!receipt.signature;
}
export function hasSignalReceipt(proof: ReceiptProof | null | undefined, recovery: SignalRecovery | null | undefined, identity:{proofId:string;evidenceId:string}): boolean {
  return !!proof && !!recovery && proof.proofId===identity.proofId && recovery.proofId===identity.proofId && proof.status==='FINALIZED' && !!proof.finalizedAt &&
    proof.evidence.some(item=>item.evidenceId===identity.evidenceId && item.validationStatus==='COMMITTED') &&
    isDurableSignalOperation(recovery.evidence.find(item=>item.evidenceId===identity.evidenceId)) && isDurableSignalOperation(recovery.finalization);
}
export function signalDuration(durationMs:number|null|undefined):string {
  if(durationMs==null||!Number.isFinite(durationMs))return 'Recording';
  const seconds=Math.max(0,Math.round(durationMs/1000));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
}
