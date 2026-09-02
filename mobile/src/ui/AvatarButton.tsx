import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, typography } from "../theme/tokens";
import { profileInitials } from "../copy/format";

export function AvatarButton(props: {
  displayName?: string | null;
  username?: string | null;
  notify?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel="Account"
      style={styles.wrap}
    >
      <View style={styles.avatar}>
        <Text style={styles.initials}>{profileInitials(props.displayName, props.username)}</Text>
      </View>
      {props.notify ? <View style={styles.dot} accessibilityLabel="You have pending invitations" /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.navy,
    alignItems: "center",
    justifyContent: "center",
  },
  initials: { ...typography.secondaryStrong, color: colors.white },
  dot: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.blue,
    borderWidth: 2,
    borderColor: colors.background,
  },
});
