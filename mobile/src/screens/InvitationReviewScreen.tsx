import { StyleSheet, Text } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { displayName, orderReferenceLabel } from "../copy/format";
import { typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { InfoCard } from "../ui/ProofCard";
import { ErrorBanner } from "../ui/EmptyState";

export function InvitationReviewScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const invite = app.selectedInvite;
  if (!invite) {
    return (
      <AppScreen>
        <AppHeader title="Invitation" onBack={app.goBack} />
        <Text style={[styles.body, { color: colors.textPrimary }]}>This invitation is no longer available.</Text>
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
      <ErrorBanner message={app.error} />
      <InfoCard>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{invite.transaction.itemTitle ?? "PackProof invitation"}</Text>
        {invite.transaction.externalReference ? (
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            {orderReferenceLabel(invite.transaction.externalReference)}
          </Text>
        ) : null}
      </InfoCard>
      <InfoCard>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Seller</Text>
        <Text style={[styles.body, { color: colors.textPrimary }]}>{inviter}</Text>
      </InfoCard>
      <Text style={[styles.note, { color: colors.textSecondary }]}>
        Joining records your participation. It does not confirm the contents of the package.
      </Text>
      <Button label="Review Proof" onPress={() => void app.acceptInvite(invite.invitationId)} loading={app.busy} />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.cardTitle },
  label: { ...typography.caption },
  body: { ...typography.body },
  meta: { ...typography.secondary },
  note: { ...typography.secondary },
});
