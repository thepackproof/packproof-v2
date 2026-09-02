import { Share, StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { inviteParticipantHint, inviteParticipantTitle } from "../copy/custody";
import { invitationStateLabel } from "../copy/status";
import { spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { ParticipantRow } from "../ui/ParticipantRow";
import { ErrorBanner } from "../ui/EmptyState";
import { SkeletonBlock } from "../ui/Skeleton";

export function InviteScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const proof = app.proof;
  return (
    <AppScreen extraBottom={24}>
      <AppHeader title={inviteParticipantTitle(proof?.workflowType)} onBack={app.goBack} />
      <Text style={[styles.body, { color: colors.textSecondary }]}>
        {inviteParticipantHint(proof?.workflowType)}
      </Text>
      <ErrorBanner message={app.error} />
      <FormField label="Search PackProof username" value={app.searchQuery} onChangeText={app.setSearchQuery} />
      {app.searchStatus === "idle" ? (
        <Text style={[styles.meta, { color: colors.textMuted }]}>Enter at least two characters to find a PackProof user.</Text>
      ) : null}
      {app.searchStatus === "loading" ? (
        <View style={styles.loading} accessibilityLabel="Searching">
          <SkeletonBlock height={48} />
          <SkeletonBlock height={48} />
        </View>
      ) : null}
      {app.searchStatus === "empty" ? (
        <Text style={[styles.meta, { color: colors.textSecondary }]}>No PackProof users match that search.</Text>
      ) : null}
      {app.searchResults.map((user) => {
        const state = user.invitationState ?? "NONE";
        return (
          <View key={user.userId} style={styles.row}>
            <View style={styles.flex}>
              <ParticipantRow name={user.displayName || user.username} username={user.username} role="" />
            </View>
            {state === "NONE" ? (
              <Button label="Invite" onPress={() => void app.inviteUser(user.userId)} disabled={app.busy} haptic="light" />
            ) : (
              <Text style={[styles.meta, { color: colors.textSecondary }]}>{invitationStateLabel(state)}</Text>
            )}
          </View>
        );
      })}
      <Button
        label="Share invite"
        variant="secondary"
        onPress={() => {
          const title = proof?.transaction.itemTitle ?? "a PackProof";
          void Share.share({
            message: `You’ve been invited to a PackProof for ${title}. Open PackProof to review and join.`,
          });
        }}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  body: { ...typography.body },
  meta: { ...typography.secondary },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  flex: { flex: 1 },
  loading: { gap: spacing.sm },
});
