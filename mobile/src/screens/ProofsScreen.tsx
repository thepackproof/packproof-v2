import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { isActiveProof, toProofCardModel } from "../copy/presentation";
import { colors, radii, spacing, typography } from "../theme/tokens";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { EmptyState, OfflineBanner } from "../ui/EmptyState";
import { ProofCard } from "../ui/ProofCard";

const FILTERS = [
  { id: "active", label: "Active" },
  { id: "completed", label: "Completed" },
  { id: "invitations", label: "Invitations" },
] as const;

export function ProofsScreen() {
  const app = usePackProof();
  useEffect(() => {
    void app.syncWorkspace().catch(() => undefined);
  }, []);

  const active = app.proofCollection.filter((item) => isActiveProof(item.status));
  const completed = app.proofCollection.filter((item) => item.status === "FINALIZED");

  return (
    <AppScreen onRefresh={() => void app.syncWorkspace()} refreshing={app.busy} extraBottom={24} bottomInset={false}>
      <AppHeader showLogo title="Proofs" />
      <OfflineBanner visible={app.offline} />
      <View style={styles.filters}>
        {FILTERS.map((filter) => {
          const selected = app.proofsFilter === filter.id;
          return (
            <Pressable
              key={filter.id}
              onPress={() => app.setProofsFilter(filter.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              style={[styles.chip, selected ? styles.chipActive : null]}
            >
              <Text style={[styles.chipLabel, selected ? styles.chipLabelActive : null]}>{filter.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {app.proofsFilter === "active" ? (
        active.length === 0 ? (
          <EmptyState
            title="No active PackProofs"
            body="Your active PackProof records will appear here."
            actionLabel="Create PackProof"
            onAction={() => app.setTab("create")}
          />
        ) : (
          active.map((item) => (
            <ProofCard
              key={item.proofId}
              model={toProofCardModel(item, {
                captureStatus: app.captureStatus,
                hasLocalCapture: Boolean(app.localCapture),
                captureProofId: app.session?.proofId,
              })}
              onPress={() => void app.run(async () => app.openProof(item.proofId))}
            />
          ))
        )
      ) : null}

      {app.proofsFilter === "completed" ? (
        completed.length === 0 ? (
          <EmptyState title="No completed PackProofs" body="Finalized Proofs will appear here." icon="checkmark-circle-outline" />
        ) : (
          completed.map((item) => (
            <ProofCard
              key={item.proofId}
              model={toProofCardModel(item)}
              onPress={() => void app.run(async () => app.openProof(item.proofId))}
            />
          ))
        )
      ) : null}

      {app.proofsFilter === "invitations" ? (
        app.pendingInvites.length === 0 ? (
          <EmptyState title="No pending invitations" body="You don’t have any pending invitations." icon="mail-open-outline" />
        ) : (
          app.pendingInvites.map((invite) => (
            <Pressable key={invite.invitationId} onPress={() => app.openInvitation(invite)} style={styles.invite}>
              <Text style={styles.kicker}>You’ve been invited to a PackProof</Text>
              <Text style={styles.title}>{invite.transaction.itemTitle ?? "PackProof invitation"}</Text>
              <Text style={styles.meta}>
                {invite.inviter.displayName || (invite.inviter.username ? `@${invite.inviter.username}` : "A participant")}
              </Text>
              <Text style={styles.cta}>Review</Text>
            </Pressable>
          ))
        )
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: "row", gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    minHeight: 40,
    justifyContent: "center",
  },
  chipActive: { backgroundColor: colors.navy, borderColor: colors.navy },
  chipLabel: { ...typography.secondaryStrong, color: colors.navy },
  chipLabelActive: { color: colors.white },
  invite: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  kicker: { ...typography.caption, color: colors.blue },
  title: { ...typography.cardTitle, color: colors.navy },
  meta: { ...typography.secondary, color: colors.slate },
  cta: { ...typography.secondaryStrong, color: colors.blue },
});
