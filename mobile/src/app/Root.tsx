import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
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
import { CompletionScreen } from "../screens/CompletionScreen";
import { InviteScreen } from "../screens/InviteScreen";
import { InvitationReviewScreen } from "../screens/InvitationReviewScreen";
import { EventDetailScreen } from "../screens/EventDetailScreen";
import { EditPurchaseScreen, EditShippingScreen } from "../screens/EditDetailsScreen";
import { DevToolsScreen } from "../screens/DevToolsScreen";
import { PackingStationScreen } from "../screens/PackingStationScreen";

export function Root() {
  const app = usePackProof();
  const theme = useTheme();
  const immersive = isImmersiveRoute(app.route);
  const ready = theme.hydrated && app.hydrated && app.route.name !== "boot";

  useEffect(() => {
    void applySystemBars({
      scheme: theme.scheme,
      immersive: !ready || immersive,
      background: theme.colors.background,
      scanBackground: theme.colors.scanBackground,
    });
  }, [immersive, ready, theme.colors.background, theme.colors.scanBackground, theme.scheme]);

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
    return (
      <>
        <StatusBar style={statusStyle} />
        <AuthScreen />
      </>
    );
  }

  if (app.route.name === "station") {
    return (
      <>
        <StatusBar style="light" />
        <PackingStationScreen
          client={app.client}
          apiBaseUrl={app.apiBaseUrl.trim()}
          userId={app.session.userId}
          restoredCapture={app.localCapture}
          restoredKey={app.session.evidenceIdempotencyKey}
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
            void app.syncWorkspace();
          }}
        />
      </>
    );
  }

  let body = null;
  if (app.route.name === "home") {
    body = <MyProofsScreen />;
  } else if (app.route.name === "create") {
    body = <CreateScreen />;
  } else if (app.route.name === "account") {
    body = <AccountScreen />;
  } else if (app.route.name === "proof") {
    body = <ProofDetailScreen />;
  } else if (app.route.name === "capture") {
    body = <CaptureScreen />;
  } else if (app.route.name === "scan") {
    body = <ScanScreen />;
  } else if (app.route.name === "review") {
    body = <PurchaseReviewScreen />;
  } else if (app.route.name === "manual") {
    body = <ManualCreateScreen />;
  } else if (app.route.name === "finalize") {
    body = <FinalizeScreen />;
  } else if (app.route.name === "complete") {
    body = <CompletionScreen />;
  } else if (app.route.name === "invite") {
    body = <InviteScreen />;
  } else if (app.route.name === "invitation") {
    body = <InvitationReviewScreen />;
  } else if (app.route.name === "event") {
    body = <EventDetailScreen />;
  } else if (app.route.name === "editPurchase") {
    body = <EditPurchaseScreen />;
  } else if (app.route.name === "editShipping") {
    body = <EditShippingScreen />;
  } else if (app.route.name === "dev") {
    body = <DevToolsScreen />;
  }

  return (
    <>
      <StatusBar style={statusStyle} />
      {body}
    </>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  splashTitle: { ...typography.pageTitle },
  splashCopy: { ...typography.secondary },
});
