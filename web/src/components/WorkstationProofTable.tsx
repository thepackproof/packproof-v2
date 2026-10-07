import type { PackProofApi } from "../api/client";
import type { ProofCollectionItem } from "../api/types";
import { classifyProofPresentation } from "../../../backend/src/domain/proof-presentation";
import { formatWhen } from "../format";
import { Glyph } from "../site/Brand";
import { RecordThumbnail } from "./RecordThumbnail";

export const workstationPresentation = (proof: ProofCollectionItem) =>
  proof.presentation ?? classifyProofPresentation(proof);

export interface WorkstationProofActions {
  onOpenProof: (id: string) => void;
  onOpenInvitation: (id: string) => void;
  onOpenReceiver: (id: string) => void;
}

/** Presentation only: every action opens the existing authorized record flow. */
export function WorkstationProofTable(props: WorkstationProofActions & {
  api?: PackProofApi;
  proofs: ProofCollectionItem[];
  label?: string;
}) {
  const rows = [...new Map(props.proofs.map(proof => [proof.proofId, proof])).values()];
  const open = (proof: ProofCollectionItem) => {
    if (proof.accessKind === "RECEIVER") props.onOpenReceiver(proof.proofId);
    else if (proof.invitationId) props.onOpenInvitation(proof.invitationId);
    else props.onOpenProof(proof.proofId);
  };
  return <div className="workstation-table-scroll">
    <table className="workstation-proof-table" aria-label={props.label || "Proofs"}>
      <thead><tr><th scope="col">Shipment</th><th scope="col">Status</th><th scope="col">Tracking</th><th scope="col">Updated</th><th scope="col"><span className="visually-hidden">Open Proof</span></th></tr></thead>
      <tbody>{rows.map(proof => {
        const state = workstationPresentation(proof);
        const title = proof.transaction.externalReference || proof.transaction.itemTitle || "Untitled shipment";
        return <tr key={proof.proofId} onClick={() => open(proof)}>
          <td><button type="button" className="workstation-proof-open proof-row" id={`proof-row-${proof.proofId}`} data-context-anchor={`proof-${proof.proofId}`} aria-label={`${proof.transaction.itemTitle || "Untitled shipment"}. ${state.displayStatus}. ${state.nextAction.label}`}>
            {proof.thumbnailDerivativeId && <RecordThumbnail api={props.api} proofId={proof.proofId} derivativeId={proof.thumbnailDerivativeId} />}
            <span><strong>{title}</strong><small>{proof.transaction.itemTitle || proof.proofId}</small></span>
          </button></td>
          <td><span className={`workstation-badge ${state.completed ? "is-complete" : state.needsAttention ? "needs-attention" : "is-active"}`}>{state.displayStatus}</span></td>
          <td><span className="workstation-tracking">{proof.transaction.trackingNumber || "Not assigned"}</span><small>{proof.transaction.carrier || "—"}{state.shipmentStatus ? ` · ${state.shipmentStatus}` : ""}</small></td>
          <td><time dateTime={proof.updatedAt}>{formatWhen(proof.updatedAt)}</time></td>
          <td className="workstation-row-arrow"><Glyph name="arrow" size={17} /></td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}
