import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, shadows, sizes } from "../theme/tokens";

export function CreateFab(props: { onPress: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: Math.max(insets.bottom, 16) + 8 }]}>
      <Pressable
        onPress={props.onPress}
        accessibilityRole="button"
        accessibilityLabel="Create a new Proof"
        style={({ pressed }) => [styles.fab, shadows.create, pressed ? styles.pressed : null]}
      >
        <Ionicons name="add" size={36} color={colors.white} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  fab: {
    width: sizes.createFab,
    height: sizes.createFab,
    borderRadius: sizes.createFab / 2,
    backgroundColor: colors.blue,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.88 },
});
