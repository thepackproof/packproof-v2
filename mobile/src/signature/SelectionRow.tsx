import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PressableScale } from '../ui/motion';
import { useTheme } from '../theme/ThemeProvider';

export function SelectionRow({ label, selected, onPress, disabled = false }: { label: string; selected: boolean; onPress: () => void; disabled?: boolean }) {
  const { colors } = useTheme();
  return <PressableScale accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, opacity: disabled ? 0.5 : 1 }}>
    <Ionicons name={selected ? 'checkbox' : 'square-outline'} color={selected ? colors.integrityText : colors.textSecondary} size={24} />
    <View style={{ flex: 1 }}><Text style={{ color: colors.textPrimary, fontSize: 15, lineHeight: 21 }}>{label}</Text></View>
  </PressableScale>;
}
