import { ReplayTutorial } from "../onboarding/Onboarding";
import { BillingPanel } from "../billing/BillingPanel";
import { DeveloperAccessPanel } from "../developer/DeveloperAccessPanel";
import { useDeveloperAccess } from "../developer/useDeveloperAccess";
import { openRelayStation } from "../relay/RelayStationHost";
import { NotificationCenter } from "../notifications/NotificationCenter";
import { IntakeSettings } from "../intake/IntakeSettings";
import * as Sharing from "expo-sharing";
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, BackHandler, Keyboard, Linking, StyleSheet, Switch, Text, View, useWindowDimensions } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { formatBytes, type LocalCapture } from "../capture";
import { captureRecoveryLabel, mayCleanUpCapture } from "../capture/recovery-model";
import { ETSY_ATTRIBUTION, SHOPIFY_AUTOMATIC_PROOFS_LABEL, automaticIntakeStatus, orderIntakeExplanation, orderReviewReason } from "../copy/commerce";
import { formatUserFacingError } from "../copy/errors";
import { displayName, formatDate, formatDateTime } from "../copy/format";
import { PACKPROOF_WEB_ORIGIN, PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "../copy/legal";
import { salesChannelCanConnect, salesChannels, type SalesChannel, type SalesChannelAccount } from "../copy/sales-channels";
import { connectedAccountStatusLabel } from "../copy/status";
import { useTheme } from "../theme/ThemeProvider";
import { radii, spacing, typography, type AppearancePreference } from "../theme/tokens";
import { SectionHeader } from "../ui/AppHeader";
import { WorkspaceHeader } from "../ui/WorkspaceHeader";
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
  developer: "Developer access",
  billing: "Plan and billing", notifications: "Notifications", profile: "Profile", channels: "Integrations", recordings: "Uploads",
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
  const developerAllowed = useDeveloperAccess(app.client, session?.userId ?? "", app.ensureAuth);
  const section = initialSection ?? null;
  const accountRef = useRef(session?.userId);
  accountRef.current = session?.userId;
  const [signingOut, setSigningOut] = useState(false);
  const [shop, setShop] = useState("");
  const [shopifyAutomaticProofs, setShopifyAutomaticProofs] = useState(true);
  const [connectionSetup, setConnectionSetup] = useState<Record<string, boolean>>({});
  const [connectionDetails, setConnectionDetails] = useState<Record<string, boolean>>({});
  const wide = useWindowDimensions().width >= 760;
  const [showInvitation, setShowInvitation] = useState(false);
  const [deletionRequest, setDeletionRequest] = useState<DeletionRequest | null>(null);
  const [retentionNotice, setRetentionNotice] = useState("");
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [deletionError, setDeletionError] = useState<string | null>(null);
  const channels = useMemo(() => {
    const linked = salesChannels(app.connectedAccounts, app.connections, app.connectedProviders);
    const catalog = app.connectedProviders.map(definition => linked.find(channel => channel.provider === definition.provider) ?? { provider: definition.provider, providerDisplay: definition.providerDisplay, catalog: definition, accounts: [] } satisfies SalesChannel);
    return [...catalog, ...linked.filter(channel => !app.connectedProviders.some(definition => definition.provider === channel.provider))];
  }, [app.connectedAccounts, app.connections, app.connectedProviders]);
  const unfinished = app.savedRecordings.filter(capture => capture.recovery?.phase !== "FINALIZED");
  const retained = app.savedRecordings.filter(capture => capture.recovery?.phase === "FINALIZED");
  const waiting = unfinished.filter(capture => ["LOCAL_ONLY", "UPLOAD_QUEUED"].includes(capture.recovery?.phase ?? "")).length;

  useEffect(() => {
    void app.loadConnections().catch(() => undefined);
    void app.loadConnectedAccounts().catch(() => undefined);
  }, []);
  useEffect(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => { if(Keyboard.isVisible()) { Keyboard.dismiss(); return true; } if(section) app.go("account"); else app.goBack(); return true; });
    return () => listener.remove();
  }, [section, app.go, app.goBack]);
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
  const openSection = (next: AccountSection) => app.go("account", { accountSection: next });
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
      <WorkspaceHeader section={section ? SECTION_TITLES[section] : "Settings"} />
      <View style={styles.heading}><Text style={[styles.eyebrow, { color: colors.textMuted }]}>Your workspace</Text><Text accessibilityRole="header" style={[styles.pageTitle, { color: colors.textPrimary }]}>{section ? SECTION_TITLES[section] : "Settings"}</Text><Text style={[styles.body, { color: colors.textSecondary }]}>{section === "channels" ? "Connect your orders and their source records." : section === "recordings" ? "Recordings, upload progress, and retained local copies." : section ? "Manage your PackProof preferences." : "Your account, connections, and workspace preferences."}</Text></View>
      {section ? <Button label="Back to settings" variant="tertiary" icon="chevron-back" onPress={() => app.go("account")} /> : null}
      <OfflineBanner visible={app.offline} />
      <ErrorBanner message={app.error} />

      {!section ? <>
        <View style={[styles.identity, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={[styles.avatar, { backgroundColor: colors.accentSoft }]}><Text style={[styles.avatarText, { color: colors.accentText }]}>{(session.displayName || session.username || "P").slice(0, 1).toUpperCase()}</Text></View>
          <View style={styles.rowCopy}><Text style={[styles.name, { color: colors.textPrimary }]}>{displayName({ displayName: session.displayName, username: session.username, email: session.email })}</Text>
          {session.username ? <Text style={[styles.meta, { color: colors.textSecondary }]}>@{session.username}</Text> : null}</View>
        </View>
        <View style={[styles.menu, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <AccountRow title="Profile" detail="Your name and username" icon="person-outline" onPress={() => openSection("profile")} />
          <AccountRow title="Integrations" detail={app.connectedAccounts.length ? "Manage connections and automatic orders" : "Connect your selling accounts"} icon="storefront-outline" onPress={() => openSection("channels")} />
          <AccountRow title="Uploads" detail={unfinished.length ? `${unfinished.length} ${unfinished.length === 1 ? "recording needs" : "recordings need"} attention` : retained.length ? `${retained.length} completed ${retained.length === 1 ? "copy" : "copies"} retained` : "No recordings stored here"} icon="cloud-upload-outline" onPress={() => openSection("recordings")} />
          <AccountRow title="Plan and billing" detail="Your plan, Proof allowance, and invoices" icon="card-outline" onPress={() => openSection("billing")} />
          <AccountRow title="Notifications" detail="Proof updates, delivery preferences and history" icon="notifications-outline" onPress={() => openSection("notifications")} />
          <AccountRow title="Appearance" detail={APPEARANCE_OPTIONS.find(option => option.id === theme.preference)?.label ?? "Light"} icon="contrast-outline" onPress={() => openSection("appearance")} />
          <AccountRow title="Help & support" detail="Recording, recovery, and invitations" icon="help-circle-outline" onPress={() => openSection("help")} />
          {developerAllowed ? <AccountRow title="Developer access" detail="API workspaces, keys, and permissions" icon="code-slash-outline" onPress={() => openSection("developer")} /> : null}
          <AccountRow title="Remote packing station" detail="Pair a camera and control packing from another device" icon="videocam-outline" onPress={openRelayStation} />
          <AccountRow title="Privacy & account" detail="Privacy, terms, and account deletion" icon="shield-checkmark-outline" onPress={() => openSection("privacy")} last />
        </View>
        {unfinished.length ? <Text style={[styles.meta, { color: colors.textSecondary }]}>Signing out pauses unfinished work. Sign in to this account to resume it.</Text> : null}
        <Button label="Sign out" variant="tertiary" loading={signingOut} disabled={app.busy || signingOut} onPress={() => { setSigningOut(true); void app.signOut().finally(() => setSigningOut(false)); }} />
      </> : null}

      {section === "billing" ? <BillingPanel key={`${app.apiBaseUrl}:${session.userId}`} /> : null}
      {section === "developer" ? developerAllowed ? <DeveloperAccessPanel key={`${app.apiBaseUrl}:${session.userId}`} /> : <Text style={[styles.body, { color: colors.textSecondary }]}>Developer access is unavailable for this account or could not be confirmed.</Text> : null}
      {section === "notifications" ? <NotificationCenter key={session.userId}/> : null}
      {section === "profile" ? <>
        {session.username ? <Text style={[styles.body, { color: colors.textSecondary }]}>@{session.username}</Text> : <FormField label="Username" value={app.usernameInput} onChangeText={app.setUsernameInput} />}
        <FormField label="Display name" value={app.displayNameInput} onChangeText={app.setDisplayNameInput} autoCapitalize="words" />
        {profileChanged ? <Button label="Save changes" onPress={() => void app.saveProfile()} loading={app.busy} /> : null}
      </> : null}

      {section === "channels" ? <>
        <View style={[styles.integrationNotice, { backgroundColor: colors.accentSoft }]}><Ionicons name="link-outline" size={20} color={colors.accentText} /><Text style={[styles.noticeCopy, { color: colors.textPrimary }]}>Marketplace authorization is separate from PackProof sign-in. Choose which selling accounts prepare orders automatically.</Text></View>
        {!channels.length && !app.busy ? <Text style={[styles.meta, { color: colors.textSecondary }]}>No sales channels are available right now. You can still record a shipment from Proofs.</Text> : null}
        <View style={styles.channelGrid}>{channels.map(channel => {
          const canConnect = salesChannelCanConnect(channel) && Boolean(channel.catalog?.capabilities.transactions || channel.catalog?.capabilities.fulfillment);
          const unavailable = channel.catalog?.enabled === false;
          const attention = channel.accounts.some(({ account, connection }) => account?.status === "NEEDS_REAUTH" || account?.status === "ERROR" || connection?.status === "NEEDS_REAUTH");
          const connected = channel.accounts.some(({ account, connection }) => account ? ["CONNECTED", "ACTIVE"].includes(account.status) : connection?.status === "ACTIVE");
          const status = unavailable ? "Unavailable" : attention ? "Needs attention" : connected ? "Connected" : "Not connected";
          return <View key={channel.provider} style={[styles.channelCard, { width: wide ? "48.5%" : "100%", backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.providerHeading}><View style={[styles.providerMark, { backgroundColor: colors.accentSoft }]}><Text style={[styles.providerInitial, { color: colors.accentText }]}>{channel.provider === "ebay" ? "e" : channel.providerDisplay.charAt(0)}</Text></View><View style={[styles.providerBadge, { backgroundColor: unavailable ? colors.surfaceElevated : attention ? colors.warningSoft : connected ? colors.successSoft : colors.surfaceElevated }]}><Text style={[styles.badgeLabel, { color: unavailable ? colors.textSecondary : attention ? colors.warningText : connected ? colors.successText : colors.textSecondary }]}>{status}</Text></View></View>
          <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{channel.providerDisplay}</Text>
          <Text style={[styles.meta, { color: colors.textSecondary }]}>{channel.catalog?.capabilities.transactions || channel.catalog?.capabilities.fulfillment ? "Bring synchronized orders into your packing queue." : "Account records connected to your PackProof workspace."}</Text>
          {channel.accounts.map((entry, index) => <ChannelAccount key={entry.account?.id ?? entry.connection?.connectionId ?? index} entry={entry} providerDisplay={channel.providerDisplay} />)}
          <PressableScale accessibilityRole="button" accessibilityLabel={`${connectionDetails[channel.provider] ? "Hide" : "Show"} ${channel.providerDisplay} connection details`} accessibilityState={{ expanded: Boolean(connectionDetails[channel.provider]) }} onPress={() => setConnectionDetails(previous => ({ ...previous, [channel.provider]: !previous[channel.provider] }))} style={styles.detailsToggle}><Ionicons name={connectionDetails[channel.provider] ? "chevron-down" : "chevron-forward"} size={14} color={colors.textSecondary} /><Text style={[styles.meta, { color: colors.textSecondary }]}>Connection details</Text></PressableScale>
          {connectionDetails[channel.provider] ? <View style={styles.channelAccount}><Text style={[styles.meta, { color: colors.textSecondary }]}>{unavailable ? "New connections are temporarily unavailable." : channel.catalog?.capabilities.transactions || channel.catalog?.capabilities.fulfillment ? "Your saved automation choice controls which eligible orders are added. Connecting never completes a Proof." : "This provider does not supply orders to PackProof. Sales-channel authorization is unavailable."}</Text>{channel.catalog?.limitations.map((limitation, index) => <Text key={`${index}-${limitation}`} style={[styles.meta, { color: colors.textSecondary }]}>{limitation}</Text>)}</View> : null}
          {canConnect ? <>
            {channel.catalog?.requiresShop && !connectionSetup[channel.provider] ? <Button label={`Connect ${channel.providerDisplay}`} disabled={app.busy} icon="arrow-forward" onPress={() => setConnectionSetup(previous => ({ ...previous, [channel.provider]: true }))} /> : <>
            {channel.catalog?.requiresShop ? <FormField label="Shopify shop" value={shop} onChangeText={setShop} placeholder="your-store.myshopify.com" autoCapitalize="none" /> : null}
            {channel.provider === "shopify" ? <>
              <View style={styles.automationRow}>
                <Text style={[styles.automationLabel, { color: colors.textPrimary }]}>{SHOPIFY_AUTOMATIC_PROOFS_LABEL}</Text>
                <Switch accessibilityLabel={SHOPIFY_AUTOMATIC_PROOFS_LABEL} value={shopifyAutomaticProofs} disabled={app.busy} onValueChange={setShopifyAutomaticProofs} trackColor={{ true: colors.primary }} />
              </View>
              <Text style={[styles.meta, { color: colors.textSecondary }]}>{orderIntakeExplanation(channel.provider)}</Text>
            </> : null}
            <Button label={`${channel.catalog?.requiresShop ? "Continue to" : "Connect"} ${channel.providerDisplay}`} loading={app.busy} disabled={channel.catalog?.requiresShop && !shop.trim()} onPress={() => void app.connectConnectedAccount(channel.provider, channel.provider === "shopify" ? { shop: shop.trim(), autoSyncEnabled: shopifyAutomaticProofs } : channel.catalog?.requiresShop ? { shop: shop.trim() } : undefined)} />
            {channel.catalog?.requiresShop ? <Button label="Cancel setup" variant="tertiary" disabled={app.busy} onPress={() => setConnectionSetup(previous => ({ ...previous, [channel.provider]: false }))} /> : null}
            </>}
          </> : !channel.accounts.length ? <Button label={`Connect ${channel.providerDisplay}`} disabled onPress={() => {}} /> : null}
          {!channel.catalog?.enabled && channel.accounts.length ? <Text style={[styles.meta, { color: colors.textSecondary }]}>New connections are temporarily unavailable. Existing connection and order status are shown above.</Text> : null}
        </View>; })}</View>
        <IntakeSettings />
        <Text style={[styles.meta, { color: colors.textSecondary }]}>Marketplace authorization is separate from PackProof sign-in. Recording a Proof does not mark an order shipped.</Text>
        {channels.some(channel => channel.provider === "etsy") ? <Text style={[styles.meta, { color: colors.textSecondary }]}>{ETSY_ATTRIBUTION}</Text> : null}
      </> : null}

      {section === "recordings" ? <>
        <Text style={[styles.body, { color: colors.textSecondary }]}>{waiting ? `${waiting} ${waiting === 1 ? "recording is" : "recordings are"} waiting to upload.` : "No recordings waiting to upload."}</Text>
        {app.savedRecordings.length ? <Text style={[styles.meta, { color: colors.textSecondary }]}>Local originals use {formatBytes(app.savedRecordings.reduce((sum, capture) => sum + (capture.byteSize ?? 0), 0))}. Uninstalling PackProof or losing this device can remove local-only work.</Text> : null}
        {unfinished.length ? <SectionHeader title="Needs attention" /> : null}
        {unfinished.map(capture => <RecordingRow key={capture.recovery?.operationId ?? capture.uri} capture={capture} />)}
        {retained.length ? <SectionHeader title="Completed local copies" /> : null}
        {retained.map(capture => <RecordingRow key={capture.recovery?.operationId ?? capture.uri} capture={capture} />)}
        {!app.savedRecordings.length ? <Text style={[styles.body, { color: colors.textSecondary }]}>Your saved Proofs are available in Proofs.</Text> : null}
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

      {section === "help" ? <><ReplayTutorial/>
        <SectionHeader title="Make a recording" />
        <Text style={[styles.body, { color: colors.textSecondary }]}>Choose an order, then record the item and package as you pack and seal it. Show the shipping label during that same recording. Review your video and confirm the shipping statement.</Text>
        <SectionHeader title="Find unfinished work" />
        <Text style={[styles.body, { color: colors.textSecondary }]}>Open Uploads to review or finish saving a recording on this device. A saved local video is different from a completed Proof; the app shows the current state.</Text>
        <Button label="Open uploads" variant="secondary" onPress={() => openSection("recordings")} />
        <SectionHeader title="Open an invitation" />
        <Text style={[styles.body, { color: colors.textSecondary }]}>Invitations appear in Proofs. If you were given an invitation ID, you can enter it here.</Text>
        <Button label={showInvitation ? "Hide invitation entry" : "Enter invitation ID"} variant="tertiary" onPress={() => setShowInvitation(!showInvitation)} />
        {showInvitation ? <><FormField label="Invitation ID" value={app.invitationInput} onChangeText={app.setInvitationInput} /><Button label="Open invitation" variant="secondary" loading={app.busy} disabled={!app.invitationInput.trim()} onPress={() => void app.acceptInvite(app.invitationInput.trim())} /></> : null}
        <SectionHeader title="About PackProof" />
        <Text style={[styles.body, { color: colors.textSecondary }]}>PackProof records what was submitted, when, and by whom. It preserves evidence; it does not decide who is right or prove an item is authentic.</Text>
        <StudyConsentCard key={`${app.apiBaseUrl}:${session.userId}`} />
        {__DEV__ && developerAllowed ? <Button label="Developer tools" variant="tertiary" onPress={() => app.go("dev")} /> : null}
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
  const automationLabel = (connection?.provider ?? account?.provider) === "shopify" ? SHOPIFY_AUTOMATIC_PROOFS_LABEL : "Automatically add orders";
  return <View style={styles.channelAccount}>
    {name ? <Text style={[styles.bodyStrong, { color: colors.textPrimary }]}>{name}</Text> : null}
    {account ? <Text style={[styles.meta, { color: colors.textSecondary }]}>{connectedAccountStatusLabel(account.status)}</Text> : null}
    {connection ? <>
      <View style={styles.automationRow}>
        <Text style={[styles.automationLabel, { color: colors.textPrimary }]}>{automationLabel}</Text>
        <Switch accessibilityLabel={`${automationLabel} from ${providerDisplay}${name ? `, ${name}` : ""}`} value={connection.autoSyncEnabled === true} disabled={app.busy || ((connection.status !== "ACTIVE" || connection.automationAvailable === false) && !connection.autoSyncEnabled)} onValueChange={enabled => void app.setCommerceAutomation(connection.connectionId, enabled)} trackColor={{ true: colors.primary }} />
      </View>
      <Text style={[styles.meta, { color: colors.textSecondary }]}>{automaticIntakeStatus(connection).replace("above", "here")}</Text>
      {connection.provider === "shopify" ? <Text style={[styles.meta, { color: colors.textSecondary }]}>{orderIntakeExplanation(connection.provider)}</Text> : null}
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
  heading: { gap: 8 },
  eyebrow: { fontSize: 10, lineHeight: 15, letterSpacing: 1.5, fontWeight: "700", textTransform: "uppercase" },
  pageTitle: { ...typography.pageTitle },
  identity: { gap: spacing.md, padding: spacing.lg, borderWidth: 1, borderRadius: 10, flexDirection: "row", alignItems: "center" },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 17, fontWeight: "700" },
  name: { ...typography.sectionTitle },
  cardTitle: { ...typography.cardTitle },
  meta: { ...typography.secondary },
  body: { ...typography.body },
  bodyStrong: { ...typography.bodyStrong },
  menu: { borderRadius: 10, borderWidth: 1, overflow: "hidden" },
  menuRow: { minHeight: 64, padding: spacing.lg, flexDirection: "row", alignItems: "center", gap: spacing.md },
  rowCopy: { flex: 1, gap: spacing.xs },
  appearance: { gap: spacing.sm },
  appearanceRow: { minHeight: 64, borderWidth: 1, borderRadius: radii.lg, padding: spacing.lg, flexDirection: "row", alignItems: "center", gap: spacing.md },
  channelAccount: { gap: spacing.sm, paddingVertical: spacing.sm },
  automationRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  automationLabel: { ...typography.body, flex: 1 },
  integrationNotice: { flexDirection: "row", alignItems: "flex-start", gap: 12, padding: 16, borderRadius: 8 },
  noticeCopy: { ...typography.secondary, flex: 1 },
  channelGrid: { flexDirection: "row", flexWrap: "wrap", gap: 16, alignItems: "flex-start" },
  channelCard: { borderWidth: 1, borderRadius: 10, padding: 20, gap: 14 },
  providerHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  providerMark: { width: 42, height: 42, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  providerInitial: { fontSize: 24, lineHeight: 30, fontWeight: "700" },
  providerBadge: { paddingVertical: 5, paddingHorizontal: 8, borderRadius: 5 },
  badgeLabel: { fontSize: 11, lineHeight: 16, fontWeight: "600" },
  detailsToggle: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 48 },
});
