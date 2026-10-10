import type { ProofCollectionItem } from "../api/types";
import { workstationPresentation } from "../components/WorkstationProofTable";
import { formatWhen } from "../format";

export function MobileProofRows({ proofs, busy, onOpen }: { proofs: ProofCollectionItem[]; busy?: boolean; onOpen: (proof: ProofCollectionItem) => void }) {
  return <ul className="task-proof-list">{proofs.map(proof => {
    const state = workstationPresentation(proof);
    const label = state.completed ? "View Proof" : state.nextAction.type === "RECORD_PACKING" ? "Continue Proof" : state.nextAction.type === "RESUME_UPLOAD" ? "Review upload" : state.nextAction.label;
    return <li key={proof.proofId} data-context-anchor={`proof-${proof.proofId}`}><div><h3>{proof.transaction.itemTitle || proof.transaction.externalReference || "Untitled shipment"}</h3><p><span className={`task-status ${state.completed ? "is-complete" : state.needsAttention ? "needs-attention" : ""}`}>{state.completed ? "Proof finalized" : state.displayStatus}</span></p><time dateTime={proof.updatedAt}>Updated {formatWhen(proof.updatedAt)}</time></div><button id={`proof-row-${proof.proofId}`} className="btn btn-secondary" disabled={busy} onClick={() => onOpen(proof)} aria-label={`${label}: ${proof.transaction.itemTitle || "Untitled shipment"}`}>{label}</button></li>;
  })}</ul>;
}
