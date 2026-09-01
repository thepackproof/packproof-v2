import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import {
  awaitingEvidenceCount,
  homeSummaryLine,
  isActiveProof,
  readyToFinalizeCount,
  selectAttention,
  toProofCardModel,
} from "../copy/presentation";
import { displayName, firstName, greetingNow } from "../copy/format";
import { colors, spacing, typography } from "../theme/tokens";
import { AppHeader, SectionHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { EmptyState, OfflineBanner } from "../ui/EmptyState";
import { InfoCard, ProofCard } from "../ui/ProofCard";
import { StatusBadge } from "../ui/StatusBadge";

export function HomeScreen() {
  const app = usePackProof();
  const session = app.session;
  useEffect(() => {
    void app.syncWorkspace().catch(() => undefined);
  }, []);

  if (!session) {
    return null;
  }

  const name = firstName(displayName({ displayName: session.displayName, username: session.username, email: session.email }));
  const active = app.proofCollection.filter((item) => isActiveProof(item.status));
  const completed = app.proofCollection.filter((item) => item.status === "FINALIZED");
  const awaiting = awaitingEvidenceCount(app.proofCollection);
  const ready = readyToFinalizeCount(app.proofCollection);
  const attention = selectAttention({
    proofs: app.proofCollection,
    invitations: app.pendingInvites,
    captureProofId: session.proofId,
    captureStatus: app.captureStatus,
    hasLocalCapture: Boolean(app.localCapture),
  });
  const recent = [...active, ...completed].slice(0, 5).map((item) =>
    toProofCardModel(item, {
      captureStatus: app.captureStatus,
      hasLocalCapture: Boolean(app.localCapture),
      captureProofId: session.proofId,
    }),
  );
  const summary = homeSummaryLine({
    activeCount: active.length,
    awaitingEvidenceCount: awaiting,
    readyToFinalizeCount: ready,
    invitationCount: app.pendingInvites.length,
  });

  return (
    <AppScreen onRefresh={() => void app.syncWorkspace()} refreshing={app.busy} extraBottom={24} bottomInset={false}>
      <AppHeader showLogo title="Home" />
      <Text style={styles.hello}>{name ? `${greetingNow()}, ${name}` : greetingNow()}</Text>
      <OfflineBanner visible={app.offline} />
      {app.error ? <Text style={styles.error}>{app.error}</Text> : null}
      {!session.username ? (
        <InfoCard onPress={() => app.setTab("account")}>
          <Text style={styles.cardTitle}>Add a username</Text>
          <Text style={styles.meta}>Others can find and invite you once your PackProof username is set.</Text>
        </InfoCard>
      ) : null}
      <Text style={styles.summary}>{summary}</Text>

      {attention ? (
        <InfoCard
          onPress={() => {
            if (attention.kind === "invitation" && attention.invitationId) {
              const invite = app.pendingInvites.find((item) => item.invitationId === attention.invitationId);
              if (invite) {
                app.openInvitation(invite);
              }
              return;
            }
            if (attention.proofId) {
              void app.run(async () => app.openProof(attention.proofId as string));
            }
          }}
        >
          <Text style={styles.kicker}>{attention.kind === "invitation" ? "Needs attention" : "Continue"}</Text>
          <Text style={styles.cardTitle}>{attention.title}</Text>
          <View style={styles.row}>
            <StatusBadge label={attention.statusLabel} />
            {attention.shipping ? <Text style={styles.meta}>{attention.shipping}</Text> : null}
          </View>
          <Text style={styles.cta}>{attention.cta}</Text>
        </InfoCard>
      ) : (
        <EmptyState
          title="No active PackProofs"
          body="Your active PackProof records will appear here."
          actionLabel="Create PackProof"
          onAction={() => app.setTab("create")}
          icon="shield-outline"
        />
      )}

      <SectionHeader title="Recent Proofs" />
      {recent.length === 0 ? (
        <Text style={styles.meta}>Finalized and in-progress records will show here.</Text>
      ) : (
        recent.map((model) => (
          <ProofCard key={model.proofId} model={model} onPress={() => void app.run(async () => app.openProof(model.proofId))} />
        ))
      )}

      {app.pendingInvites.length > 0 ? (
        <>
          <SectionHeader title="Pending invitations" />
          {app.pendingInvites.map((invite) => (
            <Pressable
              key={invite.invitationId}
              onPress={() => app.openInvitation(invite)}
              style={styles.invite}
              accessibilityRole="button"
              accessibilityLabel="Review invitation"
            >
              <Text style={styles.kicker}>You’ve been invited to a PackProof</Text>
              <Text style={styles.cardTitle}>{invite.transaction.itemTitle ?? "PackProof invitation"}</Text>
              <Text style={styles.meta}>
                {invite.inviter.displayName || invite.inviter.username
                  ? `${invite.inviter.displayName || `@${invite.inviter.username}`} invited you`
                  : "A participant invited you"}
              </Text>
              <Text style={styles.cta}>Review</Text>
            </Pressable>
          ))}
        </>
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  hello: { ...typography.greeting, color: colors.navy },
  summary: { ...typography.secondary, color: colors.slate },
  error: { ...typography.secondary, color: colors.danger },
  kicker: { ...typography.caption, color: colors.blue },
  cardTitle: { ...typography.cardTitle, color: colors.navy },
  meta: { ...typography.secondary, color: colors.slate },
  cta: { ...typography.secondaryStrong, color: colors.blue },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  invite: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: spacing.lg,
    gap: spacing.sm,
  },
});
