import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePackProof } from "../app/PackProofProvider";
import { spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { haptic } from "../theme/haptics";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { ErrorBanner } from "../ui/EmptyState";
import { BarcodeScanView } from "./BarcodeScanView";

export function ScanScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const result = app.scanResult;

  return (
    <View
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
  root: { flex: 1, paddingHorizontal: spacing.lg, gap: spacing.md },
  title: { ...typography.pageTitle },
  prompt: { ...typography.body },
  found: { gap: spacing.md, borderRadius: 16, padding: spacing.lg },
  item: { ...typography.sectionTitle },
  meta: { ...typography.secondary },
});
