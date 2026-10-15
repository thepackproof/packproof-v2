import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeProvider';
import { typography, taskFirstTypography } from '../theme/tokens';
import { PressableScale } from './motion';
import { ANDROID_TASK_FIRST_REBUILD } from '../experience/android-task-first';

export function CompactProofRow({ title, detail, onPress, disabled, completed, icon, tone }: {
  title: string; detail: string; onPress: () => void; disabled?: boolean; completed?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  tone?: 'neutral' | 'attention' | 'error';
}) {
  const { colors } = useTheme();
  const foreground = completed ? colors.successText : tone === 'attention' ? colors.warningText : tone === 'error' ? colors.error : colors.accentText;
  const background = completed ? colors.successSoft : tone === 'attention' ? colors.warningSoft : tone === 'error' ? colors.errorSoft : colors.accentSoft;
  return <PressableScale accessibilityRole="button" accessibilityLabel={`${title}. ${detail}`} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.row, { borderBottomColor: colors.divider }]}>
    {ANDROID_TASK_FIRST_REBUILD ? <View style={[styles.tile, { backgroundColor: background }]}><Ionicons name={icon ?? (completed ? 'checkmark-outline' : tone === 'attention' ? 'time-outline' : tone === 'error' ? 'alert-outline' : 'document-text-outline')} size={21} color={foreground} /></View> : null}
    <View style={styles.copy}><Text style={[styles.title, ANDROID_TASK_FIRST_REBUILD && taskFirstTypography.rowTitle, { color: colors.textPrimary }]}>{title}</Text><Text style={[styles.detail, ANDROID_TASK_FIRST_REBUILD && taskFirstTypography.finePrint, { color: completed ? colors.successText : colors.textSecondary }]}>{detail}</Text></View>
    <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
  </PressableScale>;
}
const styles = StyleSheet.create({ row: { minHeight: 72, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1 }, tile: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }, copy: { flex: 1, minWidth: 0, gap: 5 }, title: { ...typography.bodyStrong, fontSize: 16, lineHeight: 23 }, detail: { ...typography.secondary, fontSize: 14, lineHeight: 21 } });
