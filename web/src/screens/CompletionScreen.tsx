import type { PackProofApi } from "../api/client";
import { PreservationStatus } from "../components/PreservationStatus";
import { proofIdLabel } from "@packproof/copy/format";

export function CompletionScreen(props: {
  proofId: string | null;
  api: PackProofApi;
  onViewProof: () => void;
  onGoHome: () => void;
}) {
  return (
    <main className="page completion-page">
      <img src="/packproof-logo.png" alt="" width={72} height={72} />
      <p className="kicker completion-kicker">PACKPROOF RECORD</p>
      <h1>Check your finalization status.</h1>
      {props.proofId && <PreservationStatus api={props.api} proofId={props.proofId} />}
      <p className="note">Keep your local recording until preservation is confirmed. Later carrier observations and attributed responses can be appended to a finalized Proof.</p>
      {props.proofId ? <p className="meta">{proofIdLabel(props.proofId)}</p> : null}
      <div className="btn-row">
        <button className="btn" type="button" onClick={props.onViewProof}>
          View Proof
        </button>
        <button className="btn btn-tertiary" type="button" onClick={props.onGoHome}>
          My Proofs
        </button>
      </div>
    </main>
  );
}
