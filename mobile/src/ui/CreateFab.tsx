import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sizes } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { motion } from "../theme/motion";
import { haptic } from "../theme/haptics";
import { PressableScale } from "./motion";

export function CreateFab(props: { onPress: () => void }) {
  const insets = useSafeAreaInsets();
  const { colors, shadows } = useTheme();
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: Math.max(insets.bottom, 16) + 8 }]}>
      <PressableScale
        onPress={() => {
          void haptic("light");
          props.onPress();
        }}
        accessibilityRole="button"
        accessibilityLabel="Create a new Proof"
        scaleTo={motion.fabPressScale}
        style={[styles.fab, shadows.create, { backgroundColor: colors.fab }]}
      >
        <Ionicons name="add" size={36} color={colors.textOnPrimary} />
      </PressableScale>
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
    alignItems: "center",
    justifyContent: "center",
  },
});
