import type { ProofCollectionItem } from '../api/types';
import { workstationPresentation } from '../components/WorkstationProofTable';
import { formatWhen } from '../format';
import { SignalBadge } from '../signal/Signal';
import { RecordThumbnail } from '../components/RecordThumbnail';
import type { PackProofApi } from '../api/client';
export function MobileProofRows({proofs,busy,onOpen,api}: {proofs:ProofCollectionItem[];busy?:boolean;onOpen:(proof:ProofCollectionItem)=>void;api?:PackProofApi}) {
  return <ul className="task-proof-list">{proofs.map(proof=>{
    const state=workstationPresentation(proof), saved=state.completed;
    const upload=state.nextAction.type==='RESUME_UPLOAD';
    return <li key={proof.proofId} data-context-anchor={`proof-${proof.proofId}`}><button id={`proof-row-${proof.proofId}`} className="signal-proof-row" disabled={busy} onClick={()=>onOpen(proof)}>
      <RecordThumbnail api={api} proofId={proof.proofId} derivativeId={proof.thumbnailDerivativeId}/><span className="signal-row-copy"><strong>{proof.transaction.itemTitle||proof.transaction.externalReference||'Untitled shipment'}</strong><small>{proof.transaction.externalReference||formatWhen(proof.updatedAt)}</small><SignalBadge state={saved?'saved':upload?'uploading':state.needsAttention?'attention':'local'}>{saved?'Saved to PackProof':state.displayStatus}</SignalBadge></span><img src="/signal/chevron.svg" alt=""/>
    </button></li>;
  })}</ul>;
}
