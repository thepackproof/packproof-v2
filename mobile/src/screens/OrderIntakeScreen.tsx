import { useState } from "react";
import { Text } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { AppScreen } from "../ui/AppScreen";
import { AppHeader } from "../ui/AppHeader";
import { FormField } from "../ui/FormField";
import { Button } from "../ui/Button";
import { ErrorBanner } from "../ui/EmptyState";
import { useTheme } from "../theme/ThemeProvider";

export function OrderIntakeScreen({
  sharedText,
  onConsumed,
}: {
  sharedText?: string | null;
  onConsumed: () => void;
}) {
  const app = usePackProof(),
    { colors } = useTheme();
  const [text, setText] = useState(sharedText ?? ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  return (
    <AppScreen>
      <AppHeader
        title="Paste an order"
        onBack={() => {
          onConsumed();
          app.goBack();
        }}
      />
      <Text style={{ color: colors.textSecondary, fontSize: 16, lineHeight: 24 }}>
        Paste an order confirmation or share one from another app. You’ll review the details before
        creating a Proof.
      </Text>
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
            .then(() => app.client.previewOrderIntake(text, sharedText ? "share" : "paste"))
            .then((preview) => {
              app.beginIntakeReview(preview);
              onConsumed();
            })
            .catch((e) => setError(e instanceof Error ? e.message : "Could not read order"))
            .finally(() => setBusy(false));
        }}
      />
    </AppScreen>
  );
}
