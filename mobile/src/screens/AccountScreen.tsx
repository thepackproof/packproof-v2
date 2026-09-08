import { IntakeSettings } from "../intake/IntakeSettings";
import * as Sharing from "expo-sharing";
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, BackHandler, Keyboard, Linking, StyleSheet, Switch, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { formatBytes, type LocalCapture } from "../capture";
import { captureRecoveryLabel, mayCleanUpCapture } from "../capture/recovery-model";
import { ETSY_ATTRIBUTION, automaticIntakeStatus, orderReviewReason } from "../copy/commerce";
import { formatUserFacingError } from "../copy/errors";
import { displayName, formatDate, formatDateTime } from "../copy/format";
import { PACKPROOF_WEB_ORIGIN, PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "../copy/legal";
import { salesChannelCanConnect, salesChannels, type SalesChannelAccount } from "../copy/sales-channels";
import { connectedAccountStatusLabel } from "../copy/status";
import { useTheme } from "../theme/ThemeProvider";
import { radii, spacing, typography, type AppearancePreference } from "../theme/tokens";
import { AppHeader, SectionHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { ErrorBanner, OfflineBanner } from "../ui/EmptyState";
import { FormField } from "../ui/FormField";
import { InfoCard } from "../ui/ProofCard";
import { PressableScale } from "../ui/motion";
import { StudyConsentCard } from "../ui/StudyConsentCard";

import type { AccountSection } from "../app/navigation";
type DeletionRequest = { requestId: string; state: string; requestedAt: string; updatedAt: string };
const SECTION_TITLES: Record<AccountSection, string> = {
  profile: "Profile", channels: "Connections", recordings: "Recordings on this device",
  appearance: "Appearance", help: "Help & support", privacy: "Privacy & account",
};
const APPEARANCE_OPTIONS: Array<{ id: AppearancePreference; label: string; hint: string }> = [
  { id: "system", label: "System", hint: "Match this device" },
  { id: "light", label: "Light", hint: "Always use light PackProof" },
  { id: "dark", label: "Dark", hint: "Always use dark PackProof" },
];
const DELETION_STATUS: Record<DeletionRequest["state"], string> = {
  REQUESTED: "Request received", IN_REVIEW: "Request under review", COMPLETED: "Request completed", DECLINED: "Request declined",
};

export function AccountScreen({ initialSection }: { initialSection?: AccountSection } = {}) {
  const app = usePackProof();
  const theme = useTheme();
  const { colors } = theme;
  const session = app.session;
  const [section, setSection] = useState<AccountSection | null>(initialSection ?? null);
  const accountRef = useRef(session?.userId);
  accountRef.current = session?.userId;
  const [signingOut, setSigningOut] = useState(false);
  const [shop, setShop] = useState("");
  const [showInvitation, setShowInvitation] = useState(false);
  const [deletionRequest, setDeletionRequest] = useState<DeletionRequest | null>(null);
  const [retentionNotice, setRetentionNotice] = useState("");
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [deletionError, setDeletionError] = useState<string | null>(null);
  const channels = useMemo(() => salesChannels(app.connectedAccounts, app.connections, app.connectedProviders), [app.connectedAccounts, app.connections, app.connectedProviders]);
  const unfinished = app.savedRecordings.filter(capture => capture.recovery?.phase !== "FINALIZED");
  const retained = app.savedRecordings.filter(capture => capture.recovery?.phase === "FINALIZED");
  const waiting = unfinished.filter(capture => ["LOCAL_ONLY", "UPLOAD_QUEUED"].includes(capture.recovery?.phase ?? "")).length;

  useEffect(() => {
    void app.loadConnections().catch(() => undefined);
    void app.loadConnectedAccounts().catch(() => undefined);
  }, []);
  useEffect(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => { if(Keyboard.isVisible()) { Keyboard.dismiss(); return true; } if(section) setSection(null); else app.goBack(); return true; });
    return () => listener.remove();
  }, [section, app.goBack]);
  useEffect(() => {
    if (section !== "privacy" || !session) return;
    let active = true;
    setDeletionBusy(true);
    setDeletionError(null);
    setDeletionRequest(null);
    setRetentionNotice("");
    void app.ensureAuth().then(() => app.client.getAccountDeletionRequest()).then(result => {
      if (active) { setDeletionRequest(result.request); setRetentionNotice(result.retentionNotice); }
    }).catch(error => {
      if (active) setDeletionError(formatUserFacingError(error));
    }).finally(() => { if (active) setDeletionBusy(false); });
    return () => { active = false; };
  }, [section, session?.userId, app.client]);

  if (!session) return null;
  const profileChanged = app.displayNameInput.trim() !== (session.displayName ?? "")
    || (!session.username && Boolean(app.usernameInput.trim()));
  const openSection = (next: AccountSection) => { app.setError(null); setSection(next); };
  const requestDeletion = () => Alert.alert(
    "Request account deletion?",
    "This sends a deletion request for this PackProof account. You can check its status here. Local-only recordings may be lost if you later remove the app.",
    [{ text: "Keep account", style: "cancel" }, {
      text: "Send deletion request", style: "destructive", onPress: () => {
        setDeletionBusy(true); setDeletionError(null);
        const requestedBy = session.userId;
        void app.ensureAuth().then(() => {
          if (accountRef.current !== requestedBy) throw new Error("Open the original account to request deletion.");
          return app.client.requestAccountDeletion();
        }).then(result => {
          if (accountRef.current !== requestedBy) return;
          setDeletionRequest(result.request); setRetentionNotice(result.retentionNotice);
        }).catch(error => { if (accountRef.current === requestedBy) setDeletionError(formatUserFacingError(error)); }).finally(() => { if (accountRef.current === requestedBy) setDeletionBusy(false); });
      },
    }],
  );

  return (
    <AppScreen key={section ?? "account"} extraBottom={24}>
      <AppHeader title={section ? SECTION_TITLES[section] : "Account"} onBack={() => section ? setSection(null) : app.goBack()} />
      <OfflineBanner visible={app.offline} />
      <ErrorBanner message={app.error} />

      {!section ? <>
        <View style={styles.identity}>
          <Text style={[styles.name, { color: colors.textPrimary }]}>{displayName({ displayName: session.displayName, username: session.username, email: session.email })}</Text>
          {session.username ? <Text style={[styles.meta, { color: colors.textSecondary }]}>@{session.username}</Text> : null}
        </View>
        <View style={[styles.menu, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <AccountRow title="Profile" detail="Your name and username" icon="person-outline" onPress={() => openSection("profile")} />
          <AccountRow title="Connections" detail={app.connectedAccounts.length ? "Manage connections and automatic orders" : "Connect your selling accounts"} icon="storefront-outline" onPress={() => openSection("channels")} />
          <AccountRow title="Recordings on this device" detail={unfinished.length ? `${unfinished.length} ${unfinished.length === 1 ? "recording needs" : "recordings need"} attention` : retained.length ? `${retained.length} completed ${retained.length === 1 ? "copy" : "copies"} retained` : "No recordings stored here"} icon="videocam-outline" onPress={() => openSection("recordings")} />
          <AccountRow title="Appearance" detail={APPEARANCE_OPTIONS.find(option => option.id === theme.preference)?.label ?? "Light"} icon="contrast-outline" onPress={() => openSection("appearance")} />
          <AccountRow title="Help & support" detail="Recording, recovery, and invitations" icon="help-circle-outline" onPress={() => openSection("help")} />
          <AccountRow title="Privacy & account" detail="Privacy, terms, and account deletion" icon="shield-checkmark-outline" onPress={() => openSection("privacy")} last />
        </View>
        {unfinished.length ? <Text style={[styles.meta, { color: colors.textSecondary }]}>Signing out pauses unfinished work. Sign in to this account to resume it.</Text> : null}
        <Button label="Sign out" variant="tertiary" loading={signingOut} disabled={app.busy || signingOut} onPress={() => { setSigningOut(true); void app.signOut().finally(() => setSigningOut(false)); }} />
      </> : null}

      {section === "profile" ? <>
        {session.username ? <Text style={[styles.body, { color: colors.textSecondary }]}>@{session.username}</Text> : <FormField label="Username" value={app.usernameInput} onChangeText={app.setUsernameInput} />}
        <FormField label="Display name" value={app.displayNameInput} onChangeText={app.setDisplayNameInput} autoCapitalize="words" />
        {profileChanged ? <Button label="Save changes" onPress={() => void app.saveProfile()} loading={app.busy} /> : null}
      </> : null}

      {section === "channels" ? <>
        <Text style={[styles.body, { color: colors.textSecondary }]}>Connect where you sell. Choose which channels automatically prepare eligible orders in Proofs.</Text>
        {!channels.length && !app.busy ? <Text style={[styles.meta, { color: colors.textSecondary }]}>No sales channels are available right now. You can still record a shipment from Proofs.</Text> : null}
        {channels.map(channel => <InfoCard key={channel.provider}>
          <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{channel.providerDisplay}</Text>
          {channel.accounts.map((entry, index) => <ChannelAccount key={entry.account?.id ?? entry.connection?.connectionId ?? index} entry={entry} providerDisplay={channel.providerDisplay} />)}
          {!channel.accounts.length ? <Text style={[styles.meta, { color: colors.textSecondary }]}>Not connected</Text> : null}
          {salesChannelCanConnect(channel) ? <>
            {channel.catalog?.requiresShop ? <FormField label="Shopify shop" value={shop} onChangeText={setShop} placeholder="your-store.myshopify.com" autoCapitalize="none" /> : null}
            <Button label={`Connect ${channel.providerDisplay}`} variant="secondary" loading={app.busy} disabled={channel.catalog?.requiresShop && !shop.trim()} onPress={() => void app.connectConnectedAccount(channel.provider, channel.catalog?.requiresShop ? { shop: shop.trim() } : undefined)} />
          </> : null}
          {!channel.catalog?.enabled && channel.accounts.length ? <Text style={[styles.meta, { color: colors.textSecondary }]}>New connections are temporarily unavailable. Existing connection and order status are shown above.</Text> : null}
        </InfoCard>)}
        <IntakeSettings />
        <Text style={[styles.meta, { color: colors.textSecondary }]}>Marketplace authorization is separate from PackProof sign-in. Recording a Proof does not mark an order shipped.</Text>
        {channels.some(channel => channel.provider === "etsy") ? <Text style={[styles.meta, { color: colors.textSecondary }]}>{ETSY_ATTRIBUTION}</Text> : null}
      </> : null}

      {section === "recordings" ? <>
        <Text style={[styles.body, { color: colors.textSecondary }]}>{waiting ? `${waiting} ${waiting === 1 ? "recording is" : "recordings are"} waiting to upload.` : "No recordings waiting to upload."} Local originals use {formatBytes(app.savedRecordings.reduce((sum, capture) => sum + (capture.byteSize ?? 0), 0))}.</Text>
        <Text style={[styles.meta, { color: colors.textSecondary }]}>Unfinished recordings stay tied to this account. Uninstalling PackProof or losing this device can remove local-only work.</Text>
        {unfinished.length ? <SectionHeader title="Needs attention" /> : null}
        {unfinished.map(capture => <RecordingRow key={capture.recovery?.operationId ?? capture.uri} capture={capture} />)}
        {retained.length ? <SectionHeader title="Completed local copies" /> : null}
        {retained.map(capture => <RecordingRow key={capture.recovery?.operationId ?? capture.uri} capture={capture} />)}
        {!app.savedRecordings.length ? <Text style={[styles.body, { color: colors.textSecondary }]}>There are no local recordings on this account. Saved Proofs are available in Proofs.</Text> : null}
      </> : null}

      {section === "appearance" ? <View style={styles.appearance} accessibilityRole="radiogroup" accessibilityLabel="Appearance">
        {APPEARANCE_OPTIONS.map(option => {
          const selected = theme.preference === option.id;
          return <PressableScale key={option.id} onPress={() => void theme.setPreference(option.id)} accessibilityRole="radio" accessibilityState={{ selected }} style={[styles.appearanceRow, { borderColor: selected ? colors.primary : colors.border, backgroundColor: colors.surface }]}>
            <View style={styles.rowCopy}><Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{option.label}</Text><Text style={[styles.meta, { color: colors.textSecondary }]}>{option.hint}</Text></View>
            <Ionicons name={selected ? "radio-button-on-outline" : "radio-button-off-outline"} size={24} color={selected ? colors.primary : colors.textSecondary} />
          </PressableScale>;
        })}
      </View> : null}

      {section === "help" ? <>
        <SectionHeader title="Make a recording" />
        <Text style={[styles.body, { color: colors.textSecondary }]}>Choose an order, then record the item and package as you pack and seal it. Show the shipping label during that same recording. Review your video and confirm the shipping statement.</Text>
        <SectionHeader title="Find unfinished work" />
        <Text style={[styles.body, { color: colors.textSecondary }]}>Open Recordings on this device to review or finish saving a recording. A saved local video is different from a completed Proof; the app shows the current state.</Text>
        <Button label="Open recordings on this device" variant="secondary" onPress={() => openSection("recordings")} />
        <SectionHeader title="Open an invitation" />
        <Text style={[styles.body, { color: colors.textSecondary }]}>Invitations appear in Proofs. If you were given an invitation ID, you can enter it here.</Text>
        <Button label={showInvitation ? "Hide invitation entry" : "Enter invitation ID"} variant="tertiary" onPress={() => setShowInvitation(!showInvitation)} />
        {showInvitation ? <><FormField label="Invitation ID" value={app.invitationInput} onChangeText={app.setInvitationInput} /><Button label="Open invitation" variant="secondary" loading={app.busy} disabled={!app.invitationInput.trim()} onPress={() => void app.acceptInvite(app.invitationInput.trim())} /></> : null}
        <SectionHeader title="About PackProof" />
        <Text style={[styles.body, { color: colors.textSecondary }]}>PackProof records what was submitted, when, and by whom. It preserves evidence; it does not decide who is right or prove an item is authentic.</Text>
        <StudyConsentCard key={`${app.apiBaseUrl}:${session.userId}`} />
        {__DEV__ ? <Button label="Developer tools" variant="tertiary" onPress={() => app.go("dev")} /> : null}
      </> : null}

      {section === "privacy" ? <>
        <Button label="Privacy Policy" variant="secondary" onPress={() => void Linking.openURL(PRIVACY_POLICY_URL)} />
        <Button label="Terms of Service" variant="secondary" onPress={() => void Linking.openURL(TERMS_OF_SERVICE_URL)} />
        <SectionHeader title="Account deletion" />
        <Text style={[styles.body, { color: colors.textSecondary }]}>{retentionNotice || "Send a request to delete this PackProof account. Submitting a request does not immediately delete your account. Your request status appears here."}</Text>
        <ErrorBanner message={deletionError} />
        {deletionRequest ? <InfoCard><Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{DELETION_STATUS[deletionRequest.state] ?? "Request updated"}</Text><Text style={[styles.meta, { color: colors.textSecondary }]}>Requested {formatDate(deletionRequest.requestedAt)}</Text></InfoCard> : null}
        {!deletionRequest ? <Button label="Request account deletion" variant="destructive" loading={deletionBusy} disabled={app.busy} onPress={requestDeletion} /> : null}
        <Button label="Account deletion outside the app" variant="tertiary" onPress={() => void Linking.openURL(`${PACKPROOF_WEB_ORIGIN}/new/delete-account`)} />
      </> : null}
    </AppScreen>
  );
}

function ChannelAccount({ entry: { account, connection }, providerDisplay }: { entry: SalesChannelAccount; providerDisplay: string }) {
  const app = usePackProof();
  const { colors } = useTheme();
  const name = account?.externalAccountName || account?.externalAccountId || connection?.externalAccountReference;
  const reconnect = account && (account.status === "NEEDS_REAUTH" || account.status === "ERROR" || connection?.status === "NEEDS_REAUTH");
  return <View style={styles.channelAccount}>
    {name ? <Text style={[styles.bodyStrong, { color: colors.textPrimary }]}>{name}</Text> : null}
    {account ? <Text style={[styles.meta, { color: colors.textSecondary }]}>{connectedAccountStatusLabel(account.status)}</Text> : null}
    {connection ? <>
      <View style={styles.automationRow}>
        <Text style={[styles.automationLabel, { color: colors.textPrimary }]}>Automatically add orders</Text>
        <Switch accessibilityLabel={`Automatically add orders from ${providerDisplay}${name ? `, ${name}` : ""}`} value={connection.autoSyncEnabled === true} disabled={app.busy || (connection.status !== "ACTIVE" && !connection.autoSyncEnabled)} onValueChange={enabled => void app.setCommerceAutomation(connection.connectionId, enabled)} trackColor={{ true: colors.primary }} />
      </View>
      <Text style={[styles.meta, { color: colors.textSecondary }]}>{automaticIntakeStatus(connection).replace("above", "here")}</Text>
      <Text style={[styles.meta, { color: colors.textSecondary }]}>{connection.lastSyncAt ? `Last successful order check: ${formatDateTime(connection.lastSyncAt)}` : "No successful order check yet."}</Text>
      {(connection.reviewOrderCount ?? 0) > 0 ? <Text style={[styles.meta, { color: colors.textSecondary }]}>{connection.reviewOrderCount} orders need review in {providerDisplay}. {(connection.reviewReasons ?? []).map(reason => `${orderReviewReason(reason.code)}: ${reason.count}`).join(" · ")}</Text> : null}
      {connection.lastErrorCode ? <Text accessibilityRole="alert" style={[styles.meta, { color: colors.warningText }]}>The last order check could not finish. {reconnect ? "Reconnect this account to continue." : "Try checking again."}</Text> : null}
      <Button label="Check for orders" variant="secondary" loading={app.busy} disabled={connection.status !== "ACTIVE"} onPress={() => void app.syncCommerceConnection(connection.connectionId)} />
    </> : account?.capabilities.transactions ? <Text style={[styles.meta, { color: colors.textSecondary }]}>Order intake is not available for this connection yet.</Text> : <Text style={[styles.meta, { color: colors.textSecondary }]}>This connection links your account; it does not supply orders.</Text>}
    {reconnect ? <Button label="Reconnect" variant="secondary" onPress={() => void app.reauthorizeConnectedAccount(account!.id)} loading={app.busy} /> : null}
    {account && account.status !== "DISCONNECTED" ? <Button label="Disconnect" variant="tertiary" loading={app.busy} onPress={() => Alert.alert(`Disconnect ${providerDisplay}?`, "Automatic order intake for this connection will stop. Existing Proofs and saved recordings stay available.", [{ text: "Keep connected", style: "cancel" }, { text: "Disconnect", style: "destructive", onPress: () => void app.disconnectConnectedAccount(account.id) }])} /> : null}
  </View>;
}

function RecordingRow({ capture }: { capture: LocalCapture }) {
  const app = usePackProof();
  const { colors } = useTheme();
  const recovery = capture.recovery;
  if (!recovery) return null;
  const completed = mayCleanUpCapture(recovery);
  return <InfoCard>
    <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{captureRecoveryLabel(recovery.phase)}</Text>
    <Text style={[styles.meta, { color: colors.textSecondary }]}>{formatBytes(capture.byteSize)}</Text>
    {recovery.lastError ? <Text style={[styles.meta, { color: colors.textSecondary }]}>{formatUserFacingError(recovery.lastError)}</Text> : null}
    {!completed ? <Button label={recovery.phase === "SUBMITTED" ? "View submitted Proof" : "Open saved recording"} variant="secondary" loading={app.busy} onPress={() => recovery.phase === "SUBMITTED" ? void app.run(() => app.openProof(capture.captureProofId!)) : void app.resumeSavedCapture(capture)} /> : null}
    <Button label="Export local recording" variant="tertiary" loading={app.busy} onPress={() => void app.run(async () => { await Sharing.shareAsync(capture.uri, { mimeType: capture.contentType, dialogTitle: "Export your original local recording" }); })} />
    <Button label={completed ? "Remove completed local copy" : "Discard local recording"} variant="tertiary" loading={app.busy} onPress={() => Alert.alert(completed ? "Remove completed local copy?" : "Discard local recording?", completed ? "PackProof will recheck preservation and finalization before removing the local copy. The server Proof remains available." : "A local-only recording cannot be recovered after removal. This does not delete any committed server evidence.", [{ text: "Keep recording", style: "cancel" }, { text: completed ? "Remove local copy" : "Discard local copy", style: "destructive", onPress: () => completed ? void app.cleanUpSavedCapture(capture) : void app.discardSavedCapture(capture) }])} />
  </InfoCard>;
}

function AccountRow({ title, detail, icon, onPress, last }: { title: string; detail: string; icon: keyof typeof Ionicons.glyphMap; onPress: () => void; last?: boolean }) {
  const { colors } = useTheme();
  return <PressableScale accessibilityRole="button" accessibilityLabel={title} accessibilityHint={detail} onPress={onPress} style={[styles.menuRow, { borderBottomColor: colors.divider, borderBottomWidth: last ? 0 : 1 }]}>
    <Ionicons name={icon} size={22} color={colors.textSecondary} />
    <View style={styles.rowCopy}><Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{title}</Text><Text style={[styles.meta, { color: colors.textSecondary }]}>{detail}</Text></View>
    <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
  </PressableScale>;
}

const styles = StyleSheet.create({
  identity: { gap: spacing.xs, paddingVertical: spacing.sm },
  name: { ...typography.sectionTitle },
  cardTitle: { ...typography.cardTitle },
  meta: { ...typography.secondary },
  body: { ...typography.body },
  bodyStrong: { ...typography.bodyStrong },
  menu: { borderRadius: radii.lg, borderWidth: 1, overflow: "hidden" },
  menuRow: { minHeight: 72, padding: spacing.lg, flexDirection: "row", alignItems: "center", gap: spacing.md },
  rowCopy: { flex: 1, gap: spacing.xs },
  appearance: { gap: spacing.sm },
  appearanceRow: { minHeight: 64, borderWidth: 1, borderRadius: radii.lg, padding: spacing.lg, flexDirection: "row", alignItems: "center", gap: spacing.md },
  channelAccount: { gap: spacing.sm, paddingVertical: spacing.sm },
  automationRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  automationLabel: { ...typography.body, flex: 1 },
});
