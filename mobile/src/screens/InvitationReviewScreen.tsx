import { StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { displayName, orderReferenceLabel } from "../copy/format";
import { colors, spacing, typography } from "../theme/tokens";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { InfoCard } from "../ui/ProofCard";

export function InvitationReviewScreen() {
  const app = usePackProof();
  const invite = app.selectedInvite;
  if (!invite) {
    return (
      <AppScreen>
        <AppHeader title="Invitation" onBack={app.goBack} />
        <Text style={styles.body}>This invitation is no longer available.</Text>
      </AppScreen>
    );
  }
  const inviter = displayName({
    displayName: invite.inviter.displayName,
    username: invite.inviter.username,
    fallback: "A participant",
  });
  return (
    <AppScreen extraBottom={24}>
      <AppHeader title="You’ve been added to a PackProof" onBack={app.goBack} />
      {app.error ? <Text style={styles.error}>{app.error}</Text> : null}
      <InfoCard>
        <Text style={styles.title}>{invite.transaction.itemTitle ?? "PackProof invitation"}</Text>
        {invite.transaction.externalReference ? (
          <Text style={styles.meta}>{orderReferenceLabel(invite.transaction.externalReference)}</Text>
        ) : null}
      </InfoCard>
      <InfoCard>
        <Text style={styles.label}>Seller</Text>
        <Text style={styles.body}>{inviter}</Text>
      </InfoCard>
      <Text style={styles.note}>Joining records your participation. It does not confirm the contents of the package.</Text>
      <Button label="Review Proof" onPress={() => void app.acceptInvite(invite.invitationId)} loading={app.busy} />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.cardTitle, color: colors.navy },
  label: { ...typography.caption, color: colors.slate },
  body: { ...typography.body, color: colors.navy },
  meta: { ...typography.secondary, color: colors.slate },
  note: { ...typography.secondary, color: colors.slate },
  error: { ...typography.secondary, color: colors.danger },
});
