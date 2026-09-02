import { Pressable, StyleSheet, Text, View } from "react-native";
import { typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { profileInitials } from "../copy/format";

export function AvatarButton(props: {
  displayName?: string | null;
  username?: string | null;
  notify?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={props.notify ? "Account, pending invitations" : "Account"}
      style={styles.wrap}
    >
      <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
        <Text style={[styles.initials, { color: colors.textOnPrimary }]}>
          {profileInitials(props.displayName, props.username)}
        </Text>
      </View>
      {props.notify ? (
        <View
          style={[styles.dot, { backgroundColor: colors.accent, borderColor: colors.background }]}
          accessibilityLabel="You have pending invitations"
        />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  initials: { ...typography.secondaryStrong },
  dot: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
  },
});
