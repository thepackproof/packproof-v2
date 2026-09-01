import { usePackProof } from "../app/PackProofProvider";
import { proofIdLabel } from "../copy/format";
import { AppScreen } from "../ui/AppScreen";
import { SuccessState } from "../ui/SuccessState";

export function CompletionScreen() {
  const app = usePackProof();
  const proof = app.proof;
  return (
    <AppScreen scroll={false} extraBottom={24}>
      <SuccessState
        title="Your evidence record has been sealed."
        body="The current Proof record is finalized. Later carrier observations can still be appended; they do not change this sealed evidence."
        detail={proof ? proofIdLabel(proof.proofId) : undefined}
        actionLabel="View Proof"
        onAction={() => app.go("proof")}
        secondaryLabel="Home"
        onSecondary={() => app.setTab("home")}
      />
    </AppScreen>
  );
}
