import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePackProof } from "../app/PackProofProvider";
import { colors, spacing, typography } from "../theme/tokens";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { BarcodeScanView } from "./BarcodeScanView";

export function ScanScreen() {
  const app = usePackProof();
  const insets = useSafeAreaInsets();
  const result = app.scanResult;

  return (
    <View style={[styles.root, { paddingTop: Math.max(insets.top, 16), paddingBottom: Math.max(insets.bottom, 16) }]}>
      <Text style={styles.title}>{app.scanPhase === "found" ? "Order found" : "Scan order"}</Text>
      {app.scanPhase === "camera" ? (
        <>
          <Text style={styles.prompt}>Point your camera at a shipping label or order barcode.</Text>
          <BarcodeScanView
            prompt=""
            lockKey="create-scan"
            onDecoded={(value) => {
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
          <Text style={styles.prompt}>Enter an order, tracking, or reference number.</Text>
          <FormField label="Reference" value={app.scanInput} onChangeText={app.setScanInput} />
          {app.error ? <Text style={styles.error}>{app.error}</Text> : null}
          <Button
            label="Continue"
            onPress={() => void app.identifyReference(app.scanInput)}
            loading={app.busy}
            disabled={!app.scanInput.trim()}
          />
          <Button label="Back" onPress={() => app.setScanPhase("camera")} variant="tertiary" />
        </>
      ) : null}

      {app.scanPhase === "found" && result ? (
        <View style={styles.found}>
          <Text style={styles.item}>{result.itemSummary}</Text>
          <Text style={styles.meta}>{result.orderLabel}</Text>
          {result.trackingHint ? <Text style={styles.meta}>{result.trackingHint}</Text> : null}
          <Button label="Continue" onPress={() => void app.continueFromScan()} loading={app.busy} />
          <Button label="Scan again" onPress={() => app.setScanPhase("camera")} variant="tertiary" />
        </View>
      ) : null}

      {app.scanPhase === "missing" ? (
        <View style={styles.found}>
          <Text style={styles.prompt}>We couldn’t find a matching order.</Text>
          <Button label="Import purchase" onPress={() => void app.importPurchase()} />
          <Button label="Enter manually" onPress={() => app.go("manual")} variant="secondary" />
          <Button label="Scan again" onPress={() => app.setScanPhase("camera")} variant="tertiary" />
        </View>
      ) : null}

      {app.scanPhase === "camera" ? null : <Button label="Cancel" onPress={app.goBack} variant="tertiary" />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.scanBg, paddingHorizontal: spacing.lg, gap: spacing.md },
  title: { ...typography.pageTitle, color: colors.scanInk },
  prompt: { ...typography.body, color: colors.scanMuted },
  error: { ...typography.secondary, color: "#F5C2C2" },
  found: { gap: spacing.md, backgroundColor: "#132533", borderRadius: 16, padding: spacing.lg },
  item: { ...typography.sectionTitle, color: colors.white },
  meta: { ...typography.secondary, color: colors.scanMuted },
});
