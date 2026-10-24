import {useSignalReceipt} from '../signal/useSignalReceipt';
import type { ProofCollectionItem } from '../api/types';
import { workstationPresentation } from '../components/WorkstationProofTable';
import { formatWhen } from '../format';
import { SignalBadge } from '../signal/Signal';
import { RecordThumbnail } from '../components/RecordThumbnail';
import type { PackProofApi } from '../api/client';
type RowProps={proof:ProofCollectionItem;busy?:boolean;onOpen:(proof:ProofCollectionItem)=>void;api?:PackProofApi};
export function MobileProofRows({proofs,...props}:Omit<RowProps,'proof'>&{proofs:ProofCollectionItem[]}){
 return <ul className="task-proof-list">{proofs.map(proof=><ProofRow key={proof.proofId} proof={proof} {...props}/>)}</ul>;
}
function ProofRow({proof,busy,onOpen,api}:RowProps){
 const state=workstationPresentation(proof),saved=useSignalReceipt(api,proof.proofId,proof.updatedAt,state.completed);
 const upload=state.nextAction.type==='RESUME_UPLOAD';
 return <li data-context-anchor={`proof-${proof.proofId}`}><button id={`proof-row-${proof.proofId}`} className="signal-proof-row" aria-label={`${state.completed?"View Proof":state.nextAction.label}: ${proof.transaction.itemTitle||proof.transaction.externalReference||"Untitled shipment"}`} disabled={busy} onClick={()=>onOpen(proof)}><RecordThumbnail api={api} proofId={proof.proofId} derivativeId={proof.thumbnailDerivativeId}/><span className="signal-row-copy"><strong>{proof.transaction.itemTitle||proof.transaction.externalReference||'Untitled shipment'}</strong><small>{proof.transaction.externalReference||formatWhen(proof.updatedAt)}</small><SignalBadge state={saved?'saved':upload?'uploading':state.needsAttention?'attention':'local'}>{saved?'Saved to PackProof':state.completed?'Proof finalized':state.displayStatus}</SignalBadge></span><img src="/signal/chevron.svg" alt=""/></button></li>;
}
