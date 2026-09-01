import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { TabId } from "../app/navigation";
import { colors, shadows, sizes, spacing, typography } from "../theme/tokens";

const TABS: Array<{ id: TabId; label: string; icon: keyof typeof Ionicons.glyphMap; create?: boolean }> = [
  { id: "home", label: "Home", icon: "home-outline" },
  { id: "proofs", label: "Proofs", icon: "albums-outline" },
  { id: "create", label: "Create", icon: "add", create: true },
  { id: "activity", label: "Activity", icon: "pulse-outline" },
  { id: "account", label: "Account", icon: "person-outline" },
];

export function TabBar(props: { active: TabId; onChange: (tab: TabId) => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }, shadows.tab]}>
      {TABS.map((tab) => {
        const active = props.active === tab.id;
        if (tab.create) {
          return (
            <Pressable
              key={tab.id}
              onPress={() => props.onChange(tab.id)}
              accessibilityRole="button"
              accessibilityLabel="Create PackProof"
              style={styles.item}
            >
              <View style={[styles.create, shadows.create, active ? styles.createActive : null]}>
                <Ionicons name="add" size={28} color={colors.white} />
              </View>
              <Text style={[styles.label, active ? styles.activeLabel : null]}>Create</Text>
            </Pressable>
          );
        }
        return (
          <Pressable
            key={tab.id}
            onPress={() => props.onChange(tab.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tab.label}
            style={styles.item}
          >
            <Ionicons name={tab.icon} size={22} color={active ? colors.navy : colors.slate} />
            <Text style={[styles.label, active ? styles.activeLabel : null]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    minHeight: sizes.tabBar,
  },
  item: { flex: 1, alignItems: "center", gap: 4, minHeight: sizes.touch, justifyContent: "flex-end" },
  label: { ...typography.caption, color: colors.slate },
  activeLabel: { color: colors.navy, fontWeight: "700" },
  create: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.navy,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -18,
  },
  createActive: { backgroundColor: colors.blue },
});
