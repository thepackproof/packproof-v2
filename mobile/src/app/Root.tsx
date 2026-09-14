import { SharedTrackingScreen, looksLikeSharedTracking } from "../screens/SharedTrackingScreen";
import { proofIdFromLink, historyShareFromLink } from "./deep-links";
import { SharingScreen } from "../screens/SharingScreen";
import { SignatureProofScreen } from "../screens/SignatureProofScreen";
import { SupportingToolsScreen } from "../screens/SupportingToolsScreen";
import { NativeCaptureHost } from "../ui/NativeCaptureHost";
import { OrderIntakeScreen } from "../screens/OrderIntakeScreen";
import { CommerceReceiptScreen } from "../screens/CommerceReceiptScreen";
import { sharedOrderText } from "../copy/share-intake";
import { useSharedOrder } from "../intake/use-shared-order";
import { useEffect, useRef, useState } from "react";
import { BackHandler, StyleSheet, Text, View, Linking, Keyboard } from "react-native";
import { StatusBar } from "expo-status-bar";
import { usePackProof } from "./PackProofProvider";
import { isImmersiveRoute } from "./navigation";
import { typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { applySystemBars } from "../theme/system-bars";
import { Logo } from "../ui/Logo";
import { AuthScreen } from "../screens/AuthScreen";
import { MyProofsScreen } from "../screens/MyProofsScreen";
import { CreateScreen } from "../screens/CreateScreen";
import { AccountScreen } from "../screens/AccountScreen";
import { ProofDetailScreen } from "../screens/ProofDetailScreen";
import { CaptureScreen } from "../screens/CaptureScreen";
import { ScanScreen } from "../screens/ScanScreen";
import { PurchaseReviewScreen } from "../screens/PurchaseReviewScreen";
import { ManualCreateScreen } from "../screens/ManualCreateScreen";
import { FinalizeScreen } from "../screens/FinalizeScreen";
import { InviteScreen } from "../screens/InviteScreen";
import { InvitationReviewScreen } from "../screens/InvitationReviewScreen";
import { EventDetailScreen } from "../screens/EventDetailScreen";
import { EditPurchaseScreen, EditShippingScreen } from "../screens/EditDetailsScreen";
import { DevToolsScreen } from "../screens/DevToolsScreen";
import { PackingStationScreen } from "../screens/PackingStationScreen";
import { CinematicCompletion } from "../ui/CinematicCompletion";
import { RouteReveal } from "../ui/motion";
import { RelayStationHost } from "../relay/RelayStationHost";

export function Root() {
  const app = usePackProof();
  return <>
    <RootContent />
    {app.hydrated && app.session && app.route.name !== 'auth' ? <RelayStationHost key={JSON.stringify([app.apiBaseUrl, app.session.userId])} /> : null}
  </>;
}

function RootContent() {
  const app = usePackProof();
  const theme = useTheme();
  const immersive = isImmersiveRoute(app.route) && app.route.name !== "capture" && app.route.name !== "station";
  const [captureIntent,setCaptureIntent]=useState<string|null>(null);
  const [linkedProofId, setLinkedProofId] = useState<string | null>(null);
  const [linkedHistoryShareId, setLinkedHistoryShareId] = useState<string | null>(null);
  const [sharedText, setSharedText] = useState<string | null>(null);
  const [sharedAsOrder,setSharedAsOrder]=useState(false);
  const [completionVisible, setCompletionVisible] = useState(false);
  const previousRoute = useRef(app.route.name);
  const ready = theme.hydrated && app.hydrated && app.route.name !== "boot";
  const nativeShare = useSharedOrder(ready && !!app.session && app.route.name === "home" && sharedText === null && !app.busy);

  useEffect(() => {
    if (!nativeShare.sharedOrder) return;
    setSharedAsOrder(nativeShare.sharedOrder.attachmentCount > 0);
    setSharedText(nativeShare.sharedOrder.text);
    app.go("intake");
  }, [nativeShare.sharedOrder?.id]);

  async function consumeSharedOrder() {
    await nativeShare.acknowledge();
    setSharedText(null);
  }

  function deferSharedOrder() {
    nativeShare.defer();
    setSharedText(null);
  }

  useEffect(() => {
    const previous = previousRoute.current;
    previousRoute.current = app.route.name;
    if (previous === "finalize" && app.route.name === "proof" && app.proof?.status === "FINALIZED") {
      setCompletionVisible(true);
    } else if (app.route.name !== "proof") {
      setCompletionVisible(false);
    }
  }, [app.route.name, app.proof?.status, app.proof?.proofId]);

  useEffect(() => {
    if (!completionVisible) return;
    const timer = setTimeout(() => setCompletionVisible(false), theme.reducedMotion ? 650 : 1700);
    return () => clearTimeout(timer);
  }, [completionVisible, theme.reducedMotion]);

  useEffect(() => {
    if (!ready || !app.session || ["auth", "account"].includes(app.route.name)) return;
    if (app.route.name === "station" && app.session?.stationActive && app.localCapture && app.session.stationProofId === app.localCapture.captureProofId) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (Keyboard.isVisible()) { Keyboard.dismiss(); return true; }
      if (app.route.name === "home") return false;
      if (!app.busy) { if(app.route.name === "station") app.go("home"); else app.goBack(); }
      return true;
    });
    return () => subscription.remove();
  }, [ready, app.session?.userId, app.route.name, app.busy, app.goBack]);

  useEffect(() => {
    void applySystemBars({
      scheme: theme.scheme,
      immersive: !ready || immersive,
      background: theme.colors.background,
      scanBackground: theme.colors.scanBackground,
    });
  }, [immersive, ready, theme.colors.background, theme.colors.scanBackground, theme.scheme]);

  useEffect(() => {
    const receive = (url: string) => {
      try {
        const link=new URL(url);
        const hostAllowed=link.protocol==="packproof:"||((link.protocol==="https:")&&["thepackproof.com","www.thepackproof.com"].includes(link.hostname));
        const captureRoute=link.protocol==="packproof:"?link.hostname==="capture":link.pathname==="/capture";
        const token=new URLSearchParams(link.hash.slice(1)).get("intent");
        if(hostAllowed&&captureRoute&&token&&/^intent_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)){setCaptureIntent(token);return;}
      } catch { /* Other supported link handlers retain their validation. */ }
      const proofId = proofIdFromLink(url);
      if (proofId) { setLinkedHistoryShareId(historyShareFromLink(url)?.shareId ?? null); setLinkedProofId(proofId); return; }
      const text = sharedOrderText(url);
      if (text) {nativeShare.defer();setSharedAsOrder(false);setSharedText(text);}
    };
    void Linking.getInitialURL()
      .then((url) => {
        if (url) receive(url);
      })
      .catch(() => undefined);
    const listener = Linking.addEventListener("url", (event) => receive(event.url));
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (ready && app.session && sharedText) app.go("intake");
  }, [ready, app.session?.userId, sharedText]);

  useEffect(() => {
    if (ready && app.session && linkedProofId) {
      const id = linkedProofId, historyShareId = linkedHistoryShareId, userId = app.session.userId, api = app.apiBaseUrl;
      setLinkedProofId(null); setLinkedHistoryShareId(null); app.go("home");
      void app.run(async () => {
        await app.openProof(id);
        app.client.assertCaptureAccount(userId, api);
        if (historyShareId) app.go("signature", { historyShareId });
      });
    }
  }, [ready, app.session?.userId, linkedProofId, linkedHistoryShareId]);

  useEffect(()=>{
    if(!ready||!app.session||!captureIntent||app.busy)return;
    const token=captureIntent;setCaptureIntent(null);void app.startCaptureIntent(token);
  },[ready,app.session?.userId,captureIntent,app.busy]);

  const statusStyle = immersive || theme.scheme === "dark" || !ready ? "light" : "dark";

  if (!ready) {
    return (
      <View style={[styles.splash, { backgroundColor: theme.colors.background }]}>
        <StatusBar style={theme.scheme === "dark" ? "light" : "dark"} />
        <Logo size={72} />
        <Text style={[styles.splashTitle, { color: theme.colors.textPrimary }]}>PackProof</Text>
        <Text style={[styles.splashCopy, { color: theme.colors.textSecondary }]}>Loading PackProof</Text>
      </View>
    );
  }

  if (app.route.name === "auth" || !app.session) {
    return <><StatusBar style={statusStyle} /><AuthScreen /></>;
  }

  if (app.route.name === "station" && app.session?.stationActive && app.localCapture && app.session.stationProofId === app.localCapture.captureProofId) {
    return (
      <>
        <StatusBar style="light" />
        <NativeCaptureHost />
        <PackingStationScreen
          client={app.client}
          apiBaseUrl={app.apiBaseUrl.trim()}
          userId={app.session.userId}
          restoredCapture={app.localCapture}
          restoredKey={app.session.evidenceIdempotencyKey}
          restoredEvidenceId={app.session.uploadEvidenceId ?? null}
          restoredProofId={app.session.stationProofId}
          restoredTransactionId={app.session.stationTransactionId}
          restoredOrderLabel={app.session.stationOrderLabel}
          restoredItemSummary={app.session.stationItemSummary}
          onPersist={app.persistStation}
          onEnsureAuth={app.ensureAuth}
          onAuthExpired={() => {
            app.setError("Session expired. Sign in again.");
            app.setAuthPane("signIn");
            app.go("auth");
          }}
          onLeave={() => {
            app.setError(null);
            app.go("home");
            void app.run(app.syncWorkspace);
          }}
        />
      </>
    );
  }

  let body = null;
  if (["home", "orders", "station"].includes(app.route.name)) body = <MyProofsScreen />;
  else if (app.route.name === "create") body = <CreateScreen />;
  else if (app.route.name === "account") body = <AccountScreen key={app.route.accountSection ?? "account"} initialSection={app.route.accountSection} />;
  else if (app.route.name === "sharing") body = <SharingScreen key={app.proof?.proofId} />;
  else if (app.route.name === "signature") body = <SignatureProofScreen key={app.proof?.proofId} />;
  else if (app.route.name === "supporting") body = <SupportingToolsScreen key={`${app.apiBaseUrl}:${app.session.userId}:${app.proof?.proofId}`} />;
  else if (app.route.name === "proof" || app.route.name === "event") {
    body = <View style={{ flex: 1 }}>
      <View key={app.proof?.proofId} style={{ flex: 1, display: app.route.name === "event" ? "none" : "flex" }} accessibilityElementsHidden={app.route.name === "event"} importantForAccessibility={app.route.name === "event" ? "no-hide-descendants" : "auto"}>
        <ProofDetailScreen />
      </View>
      {app.route.name === "event" ? <EventDetailScreen /> : null}
    </View>;
  } else if (app.route.name === "receipt" && app.receiptProofId) body = <CommerceReceiptScreen key={app.receiptProofId} />;
  else if (app.route.name === "capture") body = <CaptureScreen />;
  else if (app.route.name === "scan") body = <ScanScreen />;
  else if (app.route.name === "review") body = <PurchaseReviewScreen />;
  else if (app.route.name === "intake") body = sharedText&&!sharedAsOrder&&looksLikeSharedTracking(sharedText) ? <SharedTrackingScreen text={sharedText} onConsumed={()=>{void consumeSharedOrder().catch(()=>app.setError("Could not remove the shared order from this device. Try again."));}} onOrder={()=>setSharedAsOrder(true)}/> : <OrderIntakeScreen key={nativeShare.sharedOrder?.id ?? sharedText ?? "paste"} sharedText={sharedText} sharedWarnings={nativeShare.sharedOrder?.warnings} sharedAttachmentCount={nativeShare.sharedOrder?.attachmentCount} onConsumed={consumeSharedOrder} onDeferred={nativeShare.sharedOrder ? deferSharedOrder : undefined} />;
  else if (app.route.name === "manual") body = <ManualCreateScreen />;
  else if (app.route.name === "finalize") body = <FinalizeScreen />;
  else if (app.route.name === "invite") body = <InviteScreen />;
  else if (app.route.name === "invitation") body = <InvitationReviewScreen />;
  else if (app.route.name === "editPurchase") body = <EditPurchaseScreen />;
  else if (app.route.name === "editShipping") body = <EditShippingScreen />;
  else if (app.route.name === "dev") body = <DevToolsScreen />;

  const routeKey = `${app.route.name}:${app.route.name === "proof" || app.route.name === "event" ? app.proof?.proofId ?? "" : ""}`;
  return (
    <>
      <StatusBar style={statusStyle} />
      <NativeCaptureHost />
      <RouteReveal routeKey={routeKey}>{body}</RouteReveal>
      <CinematicCompletion visible={completionVisible} />
    </>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  splashTitle: { ...typography.pageTitle },
  splashCopy: { ...typography.secondary },
});
