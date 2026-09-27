import { Text, View } from "react-native";
import { hasRemainingShipmentScope, REMAINING_SHIPMENT_EXPLANATION, REMAINING_SHIPMENT_LABEL } from "../copy/fulfillment-scope";
import { useTheme } from "../theme/ThemeProvider";
import { spacing, typography } from "../theme/tokens";

export function RemainingShipmentNotice({ value }: { value: unknown }) {
  const { colors } = useTheme();
  if (!hasRemainingShipmentScope(value)) return null;
  return <View style={{ gap: spacing.xs }}>
    <Text style={[typography.bodyStrong, { color: colors.textPrimary }]}>{REMAINING_SHIPMENT_LABEL}</Text>
    <Text style={[typography.secondary, { color: colors.textSecondary }]}>{REMAINING_SHIPMENT_EXPLANATION}</Text>
  </View>;
}
