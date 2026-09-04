import { useState } from "react";
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

type NotificationPreference = "IMPORTANT" | "ALL" | "FINAL_ONLY";

export function InviteScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const proof = app.proof;
  const [trackerEmail, setTrackerEmail] = useState("");
  const [preference, setPreference] = useState<NotificationPreference>("IMPORTANT");
  const [emailResult, setEmailResult] = useState<string | null>(null);

  const emailLiveProof = async () => {
    if (!proof || !app.session?.token || !trackerEmail.trim()) {
      return;
    }
    await app.run(async () => {
      const base = app.apiBaseUrl.replace(/\/$/, "");
      const response = await fetch(`${base}/proofs/${encodeURIComponent(proof.proofId)}/email-subscriptions`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${app.session?.token ?? ""}`,
        },
        body: JSON.stringify({
          email: trackerEmail.trim(),
          preference,
          scope: "SUMMARY",
        }),
      });
      if (!response.ok) {
        let message = `Unable to email this Proof (${response.status}).`;
        try {
          const payload = (await response.json()) as { error?: { message?: string } };
          message = payload.error?.message ?? message;
        } catch {
          // Keep the HTTP fallback.
        }
        throw new Error(message);
      }
      const payload = (await response.json()) as {
        subscription?: { email?: string };
        emailDeliveryConfigured?: boolean;
      };
      setEmailResult(
        payload.emailDeliveryConfigured === false
          ? `Tracker created for ${payload.subscription?.email ?? trackerEmail.trim()}. Email delivery is not configured on this environment yet.`
          : `Live Proof emailed to ${payload.subscription?.email ?? trackerEmail.trim()}.`,
      );
    });
  };

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

      <View style={[styles.emailCard, { borderColor: colors.border, backgroundColor: colors.surface }]}>
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>Email live Proof</Text>
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          Send a secure view-only tracker that follows this Proof through packing, finalization, shipping, and delivery.
        </Text>
        <FormField
          label="Recipient email"
          value={trackerEmail}
          onChangeText={(value) => {
            setTrackerEmail(value);
            setEmailResult(null);
          }}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <Text style={[styles.meta, { color: colors.textMuted }]}>Email updates</Text>
        <View style={styles.preferenceRow}>
          <Button
            label="Important"
            variant={preference === "IMPORTANT" ? "primary" : "secondary"}
            onPress={() => setPreference("IMPORTANT")}
          />
          <Button
            label="All"
            variant={preference === "ALL" ? "primary" : "secondary"}
            onPress={() => setPreference("ALL")}
          />
          <Button
            label="Final only"
            variant={preference === "FINAL_ONLY" ? "primary" : "secondary"}
            onPress={() => setPreference("FINAL_ONLY")}
          />
        </View>
        <Button
          label="Email live Proof"
          onPress={() => void emailLiveProof()}
          disabled={app.busy || !proof || !trackerEmail.trim()}
          haptic="light"
        />
        {emailResult ? <Text style={[styles.meta, { color: colors.textSecondary }]}>{emailResult}</Text> : null}
      </View>

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
  sectionTitle: { ...typography.sectionTitle },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  flex: { flex: 1 },
  loading: { gap: spacing.sm },
  emailCard: {
    gap: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: spacing.lg,
  },
  preferenceRow: {
    gap: spacing.sm,
  },
});
