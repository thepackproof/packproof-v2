import { Pressable, StyleSheet, Text, View } from "react-native";
import { spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { profileInitials } from "../copy/format";

export function ParticipantRow(props: {
  name: string;
  username?: string | null;
  role: string;
  you?: boolean;
  onPress?: () => void;
}) {
  const { colors } = useTheme();
  const content = (
    <View style={styles.row}>
      <View style={[styles.avatar, { backgroundColor: colors.surfacePressed }]} accessibilityElementsHidden>
        <Text style={[styles.initials, { color: colors.textPrimary }]}>{profileInitials(props.name, props.username)}</Text>
      </View>
      <View style={styles.copy}>
        <Text style={[styles.name, { color: colors.textPrimary }]}>{props.you ? "You" : props.name}</Text>
        <Text style={[styles.meta, { color: colors.textMuted }]}>
          {props.role}
          {props.username ? ` · @${props.username}` : ""}
        </Text>
      </View>
    </View>
  );
  if (!props.onPress) {
    return content;
  }
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={`${props.you ? "You" : props.name}, ${props.role}`}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 48 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  initials: { ...typography.secondaryStrong },
  copy: { flex: 1, gap: 2 },
  name: { ...typography.bodyStrong },
  meta: { ...typography.caption },
});
