import { useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePackProof } from "../app/PackProofProvider";
import { spacing, typography, taskFirstTypography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { haptic } from "../theme/haptics";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { ErrorBanner } from "../ui/EmptyState";
import { BarcodeScanView } from "./BarcodeScanView";
import { ANDROID_TASK_FIRST_REBUILD } from "../experience/android-task-first";
import { proofDisplayTitle } from "../copy/proof-title";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { CompactProofRow } from "../ui/CompactProofRow";

export function ScanScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const result = app.scanResult;
  const [scannerNotice, setScannerNotice] = useState<string | null>(null);

  if (ANDROID_TASK_FIRST_REBUILD) {
    function scanAgain() { setScannerNotice(null); app.setScanPhase("camera"); }
    function existingProof() {
      app.setProofsView("all"); app.setProofsQuery(""); app.setProofsRoleFilter("all"); app.setProofsCarrierFilter(null); app.go("proofs");
    }
    return <AppScreen extraBottom={16}>
      <AppHeader title="Scan shipment" onBack={app.goBack} />
      <Text style={[taskFirstTypography.body, { color: colors.textSecondary }]}>Find a linked order or an existing Proof.</Text>
      <ErrorBanner message={app.error} />
      {app.offline ? <Text accessibilityLiveRegion="polite" style={[taskFirstTypography.secondary, { color: colors.warningText }]}>Reconnect to look up a shipment. Saved Proofs are still available.</Text> : null}
      {app.scanPhase === "camera" ? <>
        <BarcodeScanView prompt="Point your camera at a shipping label or order barcode." lockKey="task-first-scan"
          onDecoded={value => { void haptic("medium"); app.setScanInput(value); void app.identifyReference(value); }}
          onCancel={app.goBack}
          onPermissionDenied={() => { setScannerNotice("Camera access is off. Enter a reference below, or allow camera access in Settings."); app.setScanPhase("reference"); }}
          onUnavailable={() => { setScannerNotice("The scanner is unavailable. Enter a reference to continue."); app.setScanPhase("reference"); }} />
        {app.busy ? <Text accessibilityLiveRegion="polite" style={[taskFirstTypography.secondary, { color: colors.textSecondary }]}>Checking this reference…</Text> : null}
        <Button label="Enter reference manually" onPress={() => app.setScanPhase("reference")} disabled={app.busy} variant="secondary" />
      </> : null}
      {app.scanPhase === "reference" ? <>
        {scannerNotice ? <Text accessibilityLiveRegion="polite" style={[taskFirstTypography.secondary, { color: colors.textSecondary }]}>{scannerNotice}</Text> : null}
        <FormField label="Order or tracking reference" value={app.scanInput} onChangeText={app.setScanInput} autoCapitalize="none" maxLength={200} />
        <Button label="Find shipment" onPress={() => void app.identifyReference(app.scanInput)} loading={app.busy} disabled={!app.scanInput.trim() || app.offline} />
        {scannerNotice ? <Button label="Open camera settings" variant="tertiary" onPress={() => void Linking.openSettings()} /> : null}
        <Button label="Try scanner" onPress={scanAgain} disabled={app.busy} variant="tertiary" />
      </> : null}
      {app.scanPhase === "ambiguous" ? <View style={styles.taskResult}>
        <Text accessibilityRole="header" style={[taskFirstTypography.sectionTitle, { color: colors.textPrimary }]}>Choose the matching shipment</Text>
        <Text style={[taskFirstTypography.secondary, { color: colors.textSecondary }]}>More than one shipment uses this reference. Check the item before continuing.</Text>
        {app.scanCandidates.map(row => <CompactProofRow key={row.proofId} title={proofDisplayTitle(row)}
          detail={row.transaction.externalReference ? `Order ${row.transaction.externalReference}` : "Review this matching Proof"}
          disabled={app.busy} onPress={() => void app.openProofAction(row.proofId)} />)}
        {!app.scanCandidates.length ? <Text style={[taskFirstTypography.secondary, { color: colors.textSecondary }]}>The matching records could not be listed. Open Orders to select the shipment.</Text> : null}
        <Button label="View all orders" variant="secondary" onPress={() => app.go("orders")} />
        <Button label="Try another reference" variant="tertiary" onPress={() => app.setScanPhase("reference")} />
      </View> : null}
      {app.scanPhase === "found" && result ? <View style={[styles.taskResult, styles.taskMatch, { backgroundColor: colors.accentSoft, borderColor: colors.accentSoftBorder }]}>
        <Text accessibilityRole="header" style={[taskFirstTypography.sectionTitle, { color: colors.textPrimary }]}>Shipment found</Text>
        <Text style={[taskFirstTypography.bodyStrong, { color: colors.textPrimary }]}>{proofDisplayTitle({ proofId: result.proofId ?? undefined, transaction: { itemTitle: result.itemSummary, externalReference: result.orderLabel } })}</Text>
        <Text style={[taskFirstTypography.secondary, { color: colors.textSecondary }]}>{result.orderLabel}</Text>
        {result.trackingHint ? <Text style={[taskFirstTypography.secondary, { color: colors.textSecondary }]}>{result.trackingHint}</Text> : null}
        <Text style={[taskFirstTypography.secondary, { color: colors.textSecondary }]}>Check this is your shipment. Continue checks its latest permitted step; scanning does not start a recording.</Text>
        <Button label="Continue with this shipment" onPress={() => void app.continueFromScan()} loading={app.busy} disabled={app.offline} />
        <Button label="Scan again" onPress={scanAgain} disabled={app.busy} variant="tertiary" />
      </View> : null}
      {app.scanPhase === "missing" ? <View style={styles.taskResult}>
        <Text accessibilityRole="header" style={[taskFirstTypography.sectionTitle, { color: colors.textPrimary }]}>No matching shipment</Text>
        <Text style={[taskFirstTypography.secondary, { color: colors.textSecondary }]}>No existing order matched {app.scanInput}. You can use this reference in a new Proof.</Text>
        <Button label="Create Proof with this reference" disabled={app.busy} onPress={() => app.go("manual")} />
        <Button label="Try another reference" onPress={() => app.setScanPhase("reference")} variant="tertiary" />
      </View> : null}
      {app.scanPhase !== "missing" ? <Button label="Enter item manually" disabled={app.busy} variant="tertiary" onPress={() => app.go("manual")} /> : null}
      <Button label="Find an existing Proof" disabled={app.busy} variant="tertiary" onPress={existingProof} />
    </AppScreen>;
  }

  return (
    <ScrollView contentContainerStyle={{flexGrow:1}}
      style={[
        styles.root,
        {
          paddingTop: Math.max(insets.top, 16),
          paddingBottom: Math.max(insets.bottom, 16),
          backgroundColor: colors.scanBackground,
        },
      ]}
    >
      <Text style={[styles.title, { color: colors.scanText }]}>
        {app.scanPhase === "found" ? "Order found" : "Scan order"}
      </Text>
      {app.scanPhase === "camera" ? (
        <>
          <Text style={[styles.prompt, { color: colors.scanMuted }]}>
            Point your camera at a shipping label or order barcode.
          </Text>
          <BarcodeScanView
            prompt=""
            lockKey="create-scan"
            onDecoded={(value) => {
              void haptic("medium");
              app.setScanInput(value);
              void app.identifyReference(value);
            }}
            onCancel={app.goBack}
            onPermissionDenied={() => app.setScanPhase("reference")}
            onUnavailable={() => app.setScanPhase("reference")}
          />
          <Button label="Enter reference manually" onPress={() => app.setScanPhase("reference")} variant="secondary" />
        </>
      ) : null}

      {app.scanPhase === "reference" ? (
        <>
          <Text style={[styles.prompt, { color: colors.scanMuted }]}>Enter an order, tracking, or reference number.</Text>
          <FormField label="Reference" value={app.scanInput} onChangeText={app.setScanInput} />
          <ErrorBanner message={app.error} />
          <Button
            label="Continue"
            onPress={() => void app.identifyReference(app.scanInput)}
            loading={app.busy}
            disabled={!app.scanInput.trim()}
          />
          <Button label="Back" onPress={() => app.setScanPhase("camera")} variant="tertiary" />
        </>
      ) : null}

      {app.scanPhase === "ambiguous" ? <View style={styles.found}><Text style={[styles.prompt,{color:colors.scanMuted}]}>More than one shipment matches. Select the shipment before continuing.</Text>{app.scanCandidates.map(row=><Button key={row.proofId} label={row.transaction.itemTitle || row.transaction.externalReference || "Shipment Proof"} onPress={()=>void app.openProofAction(row.proofId)} loading={app.busy} />)}<Button label="View all orders" variant="secondary" onPress={()=>app.go("orders")}/><Button label="Try another reference" variant="tertiary" onPress={()=>app.setScanPhase("reference")}/></View> : null}
      {app.scanPhase === "found" && result ? (
        <View style={[styles.found, { backgroundColor: colors.surfaceElevated }]}>
          <Text style={[styles.item, { color: colors.scanText }]}>{result.itemSummary}</Text>
          <Text style={[styles.meta, { color: colors.scanMuted }]}>{result.orderLabel}</Text>
          {result.trackingHint ? <Text style={[styles.meta, { color: colors.scanMuted }]}>{result.trackingHint}</Text> : null}
          <Button label="Continue" onPress={() => void app.continueFromScan()} loading={app.busy} />
          <Button label="Scan again" onPress={() => app.setScanPhase("camera")} variant="tertiary" />
        </View>
      ) : null}

      {app.scanPhase === "missing" ? (
        <View style={[styles.found, { backgroundColor: colors.surfaceElevated }]}>
          <Text style={[styles.prompt, { color: colors.scanMuted }]}>We couldn’t find a matching order.</Text>
          <Text style={[styles.meta,{color:colors.scanMuted}]}>Reference: {app.scanInput}. Confirm this reference in the new Proof before associating it. A barcode is not evidence capture.</Text>
          <Button label="Create Proof with this reference" onPress={() => app.go("manual")} />
          <Button label="Scan again" onPress={() => app.setScanPhase("camera")} variant="tertiary" />
        </View>
      ) : null}

      {app.scanPhase === "camera" ? null : <Button label="Cancel" onPress={app.goBack} variant="tertiary" />}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  taskResult: { gap: 12 }, taskMatch: { padding: 16, borderWidth: 1, borderRadius: 12 },
  root: { flex: 1, paddingHorizontal: spacing.lg, gap: spacing.md },
  title: { ...typography.pageTitle },
  prompt: { ...typography.body },
  found: { gap: spacing.md, borderRadius: 16, padding: spacing.lg },
  item: { ...typography.sectionTitle },
  meta: { ...typography.secondary },
});
