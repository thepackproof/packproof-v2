import { proofIdLabel } from "@packproof/copy/format";

export function CompletionScreen(props: {
  proofId: string | null;
  onViewProof: () => void;
  onGoHome: () => void;
}) {
  return (
    <main className="page completion-page">
      <img src="/packproof-logo.png" alt="" width={72} height={72} />
      <p className="kicker completion-kicker">PACKPROOF COMPLETE</p>
      <h1>Your evidence record has been sealed.</h1>
      <p className="note">
        The current Proof record is finalized. Later carrier observations can still be appended; they do not change this
        sealed evidence.
      </p>
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
