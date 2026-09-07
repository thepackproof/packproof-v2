import * as Sharing from "expo-sharing";
import {StudyConsentCard} from '../ui/StudyConsentCard';
import { formatBytes } from "../capture";
import { captureRecoveryLabel, mayCleanUpCapture } from "../capture/recovery-model";
import { useEffect, useState } from "react";
import { Alert, Linking, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { displayName } from "../copy/format";
import { ACCOUNT_DELETION_COPY, PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "../copy/legal";
import { connectedAccountStatusLabel, providerDisplay } from "../copy/status";
import { ETSY_ATTRIBUTION, automaticIntakeStatus, orderIntakeExplanation, orderReviewReason, providerSetupMessage } from "../copy/commerce";
import { formatUserFacingError } from "../copy/errors";
import { spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import type { AppearancePreference } from "../theme/tokens";
import { AppHeader, SectionHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { InfoCard } from "../ui/ProofCard";
import { ErrorBanner, OfflineBanner } from "../ui/EmptyState";

const APPEARANCE_OPTIONS: Array<{ id: AppearancePreference; label: string; hint: string }> = [
  { id: "system", label: "System", hint: "Match this device" },
  { id: "light", label: "Light", hint: "Always use light PackProof" },
  { id: "dark", label: "Dark", hint: "Always use dark PackProof" },
];

export function AccountScreen() {
  const app = usePackProof();
  const theme = useTheme();
  const { colors } = theme;
  const session = app.session;
  const [signingOut, setSigningOut] = useState(false);
  const [shop, setShop] = useState("");
  useEffect(() => {
    void app.loadConnections().catch(() => undefined);
    void app.loadConnectedAccounts().catch(() => undefined);
  }, []);
  if (!session) {
    return null;
  }

  return (
    <AppScreen extraBottom={24}>
      <AppHeader title="Account" onBack={app.goBack} />
      <OfflineBanner visible={app.offline} />
      <ErrorBanner message={app.error} />
      <StudyConsentCard key={`${app.apiBaseUrl}:${session.userId}`}/>
      <InfoCard>
        <Text style={[styles.name, { color: colors.textPrimary }]}>
          {displayName({ displayName: session.displayName, username: session.username, email: session.email })}
        </Text>
        {session.username ? (
          <Text style={[styles.meta, { color: colors.textSecondary }]}>@{session.username}</Text>
        ) : (
          <Text style={[styles.meta, { color: colors.textSecondary }]}>Username not set</Text>
        )}
      </InfoCard>
      <SectionHeader title="Profile" />
      {!session.username ? (
        <FormField label="Username" value={app.usernameInput} onChangeText={app.setUsernameInput} />
      ) : null}
      <FormField
        label="Display name"
        value={app.displayNameInput}
        onChangeText={app.setDisplayNameInput}
        autoCapitalize="words"
      />
      <Button
        label={session.username ? "Update display name" : "Save profile"}
        onPress={() => void app.saveProfile()}
        loading={app.busy}
      />

      <SectionHeader title="Saved recordings" />
      <Text style={[styles.body, { color: colors.textSecondary }]}>Local originals use {formatBytes(app.savedRecordings.reduce((sum, capture) => sum + (capture.byteSize ?? 0), 0))}. Pending recordings stay tied to this account. Uninstalling PackProof or losing this device can remove local-only work.</Text>
      {app.savedRecordings.map(capture => <InfoCard key={capture.recovery!.operationId}>
        <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{captureRecoveryLabel(capture.recovery!.phase)}</Text>
        <Text style={[styles.meta, { color: colors.textSecondary }]}>{formatBytes(capture.byteSize)}</Text>
        {capture.recovery?.lastError ? <Text style={[styles.meta, { color: colors.textSecondary }]}>{capture.recovery.lastError.message}</Text> : null}
        <Button label="Export local recording" variant="tertiary" loading={app.busy} onPress={() => void app.run(async () => { await Sharing.shareAsync(capture.uri, { mimeType: capture.contentType, dialogTitle: "Export your original local recording" }); })} />
        {!mayCleanUpCapture(capture.recovery!) ? <Button label="Discard local recording" variant="tertiary" loading={app.busy} onPress={() => Alert.alert("Discard local recording?", "A local-only recording cannot be recovered after removal. This does not delete any committed server evidence.", [
          { text: "Keep recording", style: "cancel" }, { text: "Discard local copy", style: "destructive", onPress: () => void app.discardSavedCapture(capture) },
        ])} /> : null}
        {mayCleanUpCapture(capture.recovery!) ? <Button label="Remove completed local copy" variant="secondary" loading={app.busy}
          onPress={() => Alert.alert("Remove completed local copy?", "PackProof will recheck the preservation and finalization receipts first. The server Proof remains available.", [
            { text: "Keep copy", style: "cancel" }, { text: "Remove local copy", onPress: () => void app.cleanUpSavedCapture(capture) },
          ])} /> : capture.recovery?.phase === "SUBMITTED"
          ? <Button label="View submitted Proof" variant="secondary" loading={app.busy} onPress={() => void app.run(() => app.openProof(capture.captureProofId!))} />
          : <Button label="Open saved recording" variant="secondary" loading={app.busy} onPress={() => void app.resumeSavedCapture(capture)} />}
      </InfoCard>)}
      <SectionHeader title="Appearance" />
      <View style={styles.appearance} accessibilityRole="radiogroup" accessibilityLabel="Appearance">
        {APPEARANCE_OPTIONS.map((option) => {
          const selected = theme.preference === option.id;
          return (
            <Pressable
              key={option.id}
              onPress={() => void theme.setPreference(option.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              style={[
                styles.appearanceRow,
                {
                  borderColor: selected ? colors.accent : colors.border,
                  backgroundColor: selected ? colors.accentSoft : colors.surface,
                },
              ]}
            >
              <View>
                <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{option.label}</Text>
                <Text style={[styles.meta, { color: colors.textSecondary }]}>{option.hint}</Text>
              </View>
              <View
                style={[
                  styles.radio,
                  { borderColor: selected ? colors.accent : colors.border },
                ]}
              >
                {selected ? <View style={[styles.radioDot, { backgroundColor: colors.accent }]} /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      <SectionHeader title="Connected Accounts" />
      <Text style={[styles.body, { color: colors.textSecondary }]}>
        Connect your selling account separately from PackProof sign-in. Authorize access in the browser,
        then return here and choose whether to turn on automatic intake below.
      </Text>
      {app.connectedAccounts.length === 0 ? (
        <Text style={[styles.meta, { color: colors.textSecondary }]}>No connected accounts yet.</Text>
      ) : (
        app.connectedAccounts.map((account) => (
          <InfoCard key={account.id}>
            <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>
              {account.providerDisplay || providerDisplay(account.provider)}
            </Text>
            <Text style={[styles.meta, { color: colors.textSecondary }]}>
              {account.externalAccountName || account.externalAccountId}
            </Text>
            <Text style={[styles.meta, { color: colors.textSecondary }]}>
              {connectedAccountStatusLabel(account.status)}
            </Text>
            {account.provider === "etsy" ? <Text style={[styles.meta, { color: colors.textSecondary }]}>Read-only access to your Etsy shop orders. Choose automatic intake below to prepare eligible orders for recording.</Text> : null}
            {account.capabilities.transactions ? null : (
              <Text style={[styles.meta, { color: colors.textSecondary }]}>
                Identity linking only. This provider does not supply PackProof transactions.
              </Text>
            )}
            {account.status === "NEEDS_REAUTH" || account.status === "ERROR" ? (
              <Button
                label="Reconnect"
                variant="secondary"
                onPress={() => void app.reauthorizeConnectedAccount(account.id)}
                loading={app.busy}
              />
            ) : null}
            <Button
              label="Disconnect"
              variant="secondary"
              onPress={() => void app.disconnectConnectedAccount(account.id)}
              loading={app.busy}
            />
          </InfoCard>
        ))
      )}
      {app.connectedProviders.map((provider) => {
        const connected = app.connectedAccounts.filter((row) => row.provider === provider.provider);
        const canConnect = provider.enabled && (provider.multipleAccounts || connected.length === 0);
        if (!provider.enabled) {
          return (
            <Text key={provider.provider} style={[styles.meta, { color: colors.textSecondary }]}>
              {providerSetupMessage(provider.provider)}
            </Text>
          );
        }
        if (!canConnect) {
          return null;
        }
        return (
          <View key={provider.provider} style={styles.connectBlock}>
            {provider.provider === "etsy" ? <Text style={[styles.meta, { color: colors.textSecondary }]}>Authorize your Etsy shop to read paid orders awaiting shipment. After connecting, turn on automatic intake below to prepare Proofs for recording.</Text> : null}
            {provider.requiresShop ? (
              <FormField
                label="Shopify shop"
                value={shop}
                onChangeText={setShop}
                placeholder="your-store.myshopify.com"
                autoCapitalize="none"
              />
            ) : null}
            <Button
              label={`Connect ${provider.providerDisplay}`}
              variant="secondary"
              onPress={() =>
                void app.connectConnectedAccount(
                  provider.provider,
                  provider.requiresShop ? { shop: shop.trim() } : undefined,
                )
              }
              loading={app.busy}
              disabled={provider.requiresShop && !shop.trim()}
            />
          </View>
        );
      })}

      <SectionHeader title="Connected marketplaces" />
      {app.connectedProviders.some(provider => provider.provider === "etsy") || app.connectedAccounts.some(account => account.provider === "etsy") ? <Text style={[styles.meta, { color: colors.textSecondary }]}>{ETSY_ATTRIBUTION}</Text> : null}
      {app.connections.length === 0 ? (
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          No marketplace connections on this account yet. Connect Etsy, eBay or Shopify from Connected
          Accounts above.
        </Text>
      ) : (
        app.connections.map((connection) => (
          <InfoCard key={connection.connectionId}>
            <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>
              {connection.providerDisplay || providerDisplay(connection.provider)}
            </Text>
            <Text style={[styles.meta, { color: colors.textSecondary }]}>{connection.status}</Text>
            {connection.externalAccountReference ? (
              <Text style={[styles.meta, { color: colors.textSecondary }]}>{connection.externalAccountReference}</Text>
            ) : null}
            <View style={styles.automationRow}>
              <Text style={[styles.automationLabel, { color: colors.textPrimary }]}>Automatically prepare eligible paid orders for recording</Text>
              <Switch
                accessibilityLabel={`Automatic intake for ${connection.providerDisplay || providerDisplay(connection.provider)}`}
                value={connection.autoSyncEnabled === true}
                disabled={app.busy || (connection.status !== "ACTIVE" && !connection.autoSyncEnabled)}
                onValueChange={enabled => void app.setCommerceAutomation(connection.connectionId, enabled)}
                trackColor={{ true: colors.accent }}
              />
            </View>
            <Text style={[styles.meta, { color: colors.textSecondary }]}>{orderIntakeExplanation(connection.provider)}</Text>
            <Text style={[styles.meta, { color: colors.textSecondary }]}>{automaticIntakeStatus(connection)}</Text>
            <Text style={[styles.meta, { color: colors.textSecondary }]}>{connection.readyOrderCount} orders ready</Text>
            {(connection.reviewOrderCount ?? 0) > 0 ? <Text style={[styles.meta, { color: colors.textSecondary }]}>{connection.reviewOrderCount} orders need review and are excluded from the automatic packing queue. {(connection.reviewReasons ?? []).map(reason => `${orderReviewReason(reason.code)}: ${reason.count}`).join(" · ")}. Review the original orders in Etsy.</Text> : null}
            {connection.lastErrorCode ? <Text style={[styles.meta, { color: colors.textSecondary }]}>{formatUserFacingError({ code: connection.lastErrorCode, message: "The last order check could not finish. Try checking again or reconnect your selling account." })}</Text> : null}
            <Button
              label="Check for orders now"
              variant="secondary"
              loading={app.busy}
              disabled={connection.status !== "ACTIVE"}
              onPress={() => void app.syncCommerceConnection(connection.connectionId)}
            />
          </InfoCard>
        ))
      )}

      <SectionHeader title="Packing tools" />
      <Button label="Packing Station" onPress={() => app.go("station")} variant="secondary" />

      <SectionHeader title="About PackProof" />
      <Text style={[styles.body, { color: colors.textSecondary }]}>
        PackProof creates tamper-evident records for commerce. It records what was submitted, when, and by whom. It does
        not decide who is right.
      </Text>
      <Button label="Terms of Service" variant="tertiary" onPress={() => void Linking.openURL(TERMS_OF_SERVICE_URL)} />
      <Button label="Privacy Policy" variant="tertiary" onPress={() => void Linking.openURL(PRIVACY_POLICY_URL)} />

      <SectionHeader title="Account deletion" />
      <Text style={[styles.body, { color: colors.textSecondary }]}>{ACCOUNT_DELETION_COPY}</Text>
      <Button
        label="Open Privacy Policy"
        variant="secondary"
        onPress={() => void Linking.openURL(PRIVACY_POLICY_URL)}
      />

      {__DEV__ ? <Button label="Developer tools" onPress={() => app.go("dev")} variant="tertiary" /> : null}

      {app.savedRecordings.some(capture => capture.recovery?.phase !== "FINALIZED") ? <Text style={[styles.body, { color: colors.textSecondary }]}>Signing out pauses pending recordings. Sign in to this same account to resume them.</Text> : null}
      <Button
        label="Sign out"
        onPress={() => {
          setSigningOut(true);
          void app.signOut().finally(() => setSigningOut(false));
        }}
        variant="destructive"
        disabled={app.busy || signingOut}
        loading={signingOut}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  name: { ...typography.sectionTitle },
  cardTitle: { ...typography.cardTitle },
  meta: { ...typography.secondary },
  body: { ...typography.body },
  appearance: { gap: spacing.sm },
  connectBlock: { gap: spacing.sm },
  automationRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  automationLabel: { ...typography.body, flex: 1 },
  appearanceRow: {
    minHeight: 56,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
});
