import { StyleSheet, Text, View, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePackProof } from "../app/PackProofProvider";
import { useTheme } from "../theme/ThemeProvider";
import type { AppRouteName } from "../app/navigation";

export function MainNavigation() {
  const app = usePackProof(), { colors } = useTheme(), insets = useSafeAreaInsets();
  const items: { route: AppRouteName; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { route: "orders", label: "Orders", icon: "cube-outline" },
    { route: "home", label: "Proofs", icon: "shield-checkmark-outline" },
    { route: "account", label: "Account", icon: "person-circle-outline" },
  ];
  return <View style={[styles.bar, { backgroundColor: colors.surface, borderTopColor: colors.border, paddingBottom: insets.bottom }]}>
    {items.map(item => <Pressable key={item.route} accessibilityRole="tab" accessibilityLabel={item.label}
      accessibilityState={{ selected: app.route.name === item.route }} onPress={() => app.go(item.route)}
      style={({ pressed }) => [styles.item, { backgroundColor: pressed ? colors.surfacePressed : colors.surface }]}>
      <Ionicons name={item.icon} size={22} color={app.route.name === item.route ? colors.accent : colors.textSecondary} />
      <Text style={{ flexShrink: 1, textAlign: "center", fontSize: 14, lineHeight: 20, fontWeight: "600", color: app.route.name === item.route ? colors.accent : colors.textSecondary }}>{item.label}</Text>
    </Pressable>)}
  </View>;
}
const styles = StyleSheet.create({ bar: { flexDirection: "row", borderTopWidth: 1 }, item: { flex: 1, minHeight: 60, padding: 8, alignItems: "center", justifyContent: "center", gap: 4 } });
