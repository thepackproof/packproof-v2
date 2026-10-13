import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { PressableScale } from './motion';

export function CompactProofRow({ title, detail, onPress, disabled, completed }: {
  title: string; detail: string; onPress: () => void; disabled?: boolean; completed?: boolean;
}) {
  const { colors } = useTheme();
  return <PressableScale accessibilityRole="button" accessibilityLabel={`${title}. ${detail}`} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.row, { borderBottomColor: colors.divider }]}>
    <View style={styles.copy}><Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text><Text style={[styles.detail, { color: completed ? colors.successText : colors.textSecondary }]}>{detail}</Text></View>
    <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
  </PressableScale>;
}
const styles = StyleSheet.create({ row: { minHeight: 72, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1 }, copy: { flex: 1, minWidth: 0, gap: 5 }, title: { ...typography.bodyStrong, fontSize: 16, lineHeight: 23 }, detail: { ...typography.secondary, fontSize: 14, lineHeight: 21 } });
