import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { formatDateTime } from "../copy/format";
import { proofStatusLabel } from "../copy/status";
import { colors, spacing, typography } from "../theme/tokens";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { EmptyState, OfflineBanner } from "../ui/EmptyState";

export function ActivityScreen() {
  const app = usePackProof();
  useEffect(() => {
    void app.syncWorkspace().catch(() => undefined);
  }, []);

  const items = [
    ...app.pendingInvites.map((invite) => ({
      id: `inv-${invite.invitationId}`,
      title: "Invitation received",
      subtitle: invite.transaction.itemTitle ?? "PackProof invitation",
      at: invite.createdAt,
      onPress: () => app.openInvitation(invite),
    })),
    ...app.proofCollection.map((item) => ({
      id: `proof-${item.proofId}`,
      title:
        item.status === "FINALIZED"
          ? "Proof finalized"
          : item.status === "EVIDENCE_COMMITTED"
            ? "Evidence secured"
            : proofStatusLabel(item.status),
      subtitle: item.transaction.itemTitle ?? "PackProof",
      at: item.finalizedAt ?? item.updatedAt,
      onPress: () => void app.run(async () => app.openProof(item.proofId)),
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return (
    <AppScreen onRefresh={() => void app.syncWorkspace()} refreshing={app.busy} extraBottom={24} bottomInset={false}>
      <AppHeader showLogo title="Activity" />
      <OfflineBanner visible={app.offline} />
      {items.length === 0 ? (
        <EmptyState title="No recent activity" body="Invitations, secured evidence, and finalized Proofs will appear here." icon="pulse-outline" />
      ) : (
        items.map((item) => (
          <Pressable key={item.id} onPress={item.onPress} style={styles.row} accessibilityRole="button">
            <View style={styles.copy}>
              <Text style={styles.title}>{item.title}</Text>
              <Text style={styles.sub}>{item.subtitle}</Text>
            </View>
            <Text style={styles.time}>{formatDateTime(item.at)}</Text>
          </Pressable>
        ))
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  copy: { gap: 2 },
  title: { ...typography.cardTitle, color: colors.navy },
  sub: { ...typography.secondary, color: colors.slate },
  time: { ...typography.caption, color: colors.textMuted },
});
