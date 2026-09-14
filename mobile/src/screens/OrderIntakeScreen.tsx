import { useState } from "react";
import { Alert, Text } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { AppScreen } from "../ui/AppScreen";
import { AppHeader } from "../ui/AppHeader";
import { FormField } from "../ui/FormField";
import { Button } from "../ui/Button";
import { ErrorBanner } from "../ui/EmptyState";
import { useTheme } from "../theme/ThemeProvider";

export function OrderIntakeScreen({
  sharedText,
  sharedWarnings = [],
  sharedAttachmentCount = 0,
  onConsumed,
  onDeferred,
}: {
  sharedText?: string | null;
  sharedWarnings?: string[];
  sharedAttachmentCount?: number;
  onConsumed: () => void | Promise<void>;
  onDeferred?: () => void;
}) {
  const app = usePackProof(),
    { colors } = useTheme();
  const [text, setText] = useState(sharedText ?? ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  return (
    <AppScreen>
      <AppHeader
        title={sharedText != null ? "Review shared order" : "Paste an order"}
        onBack={() => {
          if (onDeferred) onDeferred(); else void onConsumed();
          app.goBack();
        }}
      />
      <Text style={{ color: colors.textSecondary, fontSize: 16, lineHeight: 24 }}>
        Paste an order confirmation or share one from another app. You’ll review the details before
        creating a Proof.
      </Text>
      {sharedAttachmentCount > 0 ? <Text style={{ color: colors.textSecondary, fontSize: 14, lineHeight: 20 }}>
        Read from {sharedAttachmentCount} shared {sharedAttachmentCount === 1 ? "file" : "files"}. The original files are used only to read order details; they do not become packing evidence.
      </Text> : null}
      {sharedWarnings.map((warning, index) => <Text key={index} style={{ color: colors.textSecondary, fontSize: 14, lineHeight: 20 }}>{warning}</Text>)}
      <FormField
        label="Order confirmation"
        value={text}
        onChangeText={(value) => setText(value.slice(0, 20000))}
        multiline
      />
      <ErrorBanner message={error} />
      <Button
        label={busy ? "Reading order…" : "Review order details"}
        loading={busy}
        disabled={!text.trim()}
        onPress={() => {
          setBusy(true);
          setError(null);
          void app
            .ensureAuth()
            .then(() => app.client.previewOrderIntake(text, sharedText != null ? "share" : "paste"))
            .then(async (preview) => {
              await onConsumed();
              app.beginIntakeReview(preview);
            })
            .catch((e) => setError(e instanceof Error ? e.message : "Could not read order"))
            .finally(() => setBusy(false));
        }}
      />
      {onDeferred ? <Button label="Discard shared order" variant="tertiary" disabled={busy} onPress={() => {
        Alert.alert("Discard shared order?", "This removes the shared copy from this device. The original in the other app stays available.", [
          { text: "Keep order", style: "cancel" },
          { text: "Discard", style: "destructive", onPress: () => {
            setBusy(true);
            void Promise.resolve(onConsumed()).then(() => app.goBack())
              .catch(() => setError("Could not discard the shared order. Try again."))
              .finally(() => setBusy(false));
          } },
        ]);
      }} /> : null}
    </AppScreen>
  );
}
