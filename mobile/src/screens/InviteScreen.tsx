import { Share, StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { invitationStateLabel } from "../copy/status";
import { colors, spacing, typography } from "../theme/tokens";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { ParticipantRow } from "../ui/ParticipantRow";

export function InviteScreen() {
  const app = usePackProof();
  const proof = app.proof;
  return (
    <AppScreen extraBottom={24}>
      <AppHeader title="Add buyer" onBack={app.goBack} />
      <Text style={styles.body}>Search PackProof username. Joining records participation; it does not confirm the item.</Text>
      {app.error ? <Text style={styles.error}>{app.error}</Text> : null}
      <FormField label="Search PackProof username" value={app.searchQuery} onChangeText={app.setSearchQuery} />
      {app.searchStatus === "loading" ? <Text style={styles.meta}>Searching…</Text> : null}
      {app.searchStatus === "empty" ? <Text style={styles.meta}>No PackProof users match that search.</Text> : null}
      {app.searchResults.map((user) => {
        const state = user.invitationState ?? "NONE";
        return (
          <View key={user.userId} style={styles.row}>
            <View style={styles.flex}>
              <ParticipantRow name={user.displayName || user.username} username={user.username} role="" />
            </View>
            {state === "NONE" ? (
              <Button label="Invite" onPress={() => void app.inviteUser(user.userId)} disabled={app.busy} />
            ) : (
              <Text style={styles.meta}>{invitationStateLabel(state)}</Text>
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
  body: { ...typography.body, color: colors.slate },
  meta: { ...typography.secondary, color: colors.slate },
  error: { ...typography.secondary, color: colors.danger },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  flex: { flex: 1 },
});
