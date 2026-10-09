import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePackProof } from "../app/PackProofProvider";
import { useTheme } from "../theme/ThemeProvider";
import { typography } from "../theme/tokens";
import { PressableScale } from "./motion";

const tabs = [
  { route: "home", label: "Home", icon: "home-outline" },
  { route: "proofs", label: "Proofs", icon: "document-text-outline" },
  { route: "station", label: "Pack", icon: "videocam-outline" },
  { route: "activity", label: "Activity", icon: "pulse-outline" },
] as const;

export function MobileTabBar() {
  const app = usePackProof();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return <View accessibilityRole="tablist" accessibilityLabel="Main navigation" style={[styles.bar, { backgroundColor: colors.background, borderColor: colors.border, paddingBottom: Math.max(insets.bottom, 6), paddingLeft: insets.left, paddingRight: insets.right }]}>
    {tabs.map(tab => {
      const selected = app.route.name === tab.route;
      return <View key={tab.route} style={styles.tabSlot}><PressableScale accessibilityRole="tab" accessibilityLabel={tab.label} accessibilityState={{ selected, disabled: app.busy }} disabled={app.busy} onPress={() => { if (!selected) app.go(tab.route); }} style={[styles.tab, selected && { backgroundColor: colors.accentSoft }]}>
        <Ionicons name={tab.icon} size={22} color={selected ? colors.accentText : colors.textSecondary} />
        <Text style={[styles.label, { color: selected ? colors.accentText : colors.textSecondary }]}>{tab.label}</Text>
      </PressableScale></View>;
    })}
  </View>;
}
const styles = StyleSheet.create({ bar: { flexDirection: "row", borderTopWidth: 1, paddingTop: 5, gap: 2 }, tabSlot: { flex: 1 }, tab: { minHeight: 58, minWidth: 48, alignItems: "center", justifyContent: "center", paddingVertical: 8, paddingHorizontal: 3, gap: 3, borderRadius: 10 }, label: { ...typography.caption, fontSize: 12, lineHeight: 17, textAlign: "center", flexShrink: 1 } });
