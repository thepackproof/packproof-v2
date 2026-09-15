import { Text, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { packingRecordLabel } from '../copy/evidence-record';

export function RecordSeal({ status }: { status: string }) {
  const { colors } = useTheme();
  const sealed = status === 'FINALIZED';
  return <View accessibilityLabel={packingRecordLabel(status)} style={[styles.seal, { backgroundColor: sealed ? colors.successSoft : colors.surfaceElevated, borderColor: sealed ? colors.successSoftBorder : colors.border }]}>
    <Ionicons name={sealed ? 'shield-checkmark-outline' : 'document-outline'} size={16} color={sealed ? colors.successText : colors.textSecondary} />
    <Text style={[typography.secondaryStrong, { flexShrink: 1, color: sealed ? colors.successText : colors.textSecondary }]}>{packingRecordLabel(status)}</Text>
  </View>;
}
const styles = StyleSheet.create({seal:{alignSelf:'flex-start',flexDirection:'row',gap:7,alignItems:'center',borderWidth:0,borderRadius:7,paddingHorizontal:8,paddingVertical:4}});
