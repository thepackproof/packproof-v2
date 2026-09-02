import { useEffect } from "react";
import { usePackProof } from "../app/PackProofProvider";
import { proofIdLabel } from "../copy/format";
import { haptic } from "../theme/haptics";
import { AppScreen } from "../ui/AppScreen";
import { SuccessState } from "../ui/SuccessState";

export function CompletionScreen() {
  const app = usePackProof();
  const proof = app.proof;
  useEffect(() => {
    void haptic("success");
  }, []);
  return (
    <AppScreen scroll={false} extraBottom={24}>
      <SuccessState
        title="Your evidence record has been sealed."
        body="The current Proof record is finalized. Later carrier observations can still be appended; they do not change this sealed evidence."
        detail={proof ? proofIdLabel(proof.proofId) : undefined}
        actionLabel="View Proof"
        onAction={() => app.go("proof")}
        secondaryLabel="My Proofs"
        onSecondary={() => app.go("home")}
      />
    </AppScreen>
  );
}
