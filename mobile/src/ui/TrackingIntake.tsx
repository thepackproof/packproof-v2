import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { trackingConnectionLabel, TRACKING_CARRIERS } from '../copy/tracking-connection';
import { Button } from './Button';
import { FormField } from './FormField';
import { PressableScale } from './motion';

export function TrackingIntake() {
  const app = usePackProof(), { colors } = useTheme(), proof = app.proof!;
  const shipping = proof.shipmentObservations?.identity ?? proof.transaction.shipping;
  const [open, setOpen] = useState(false), [value, setValue] = useState(shipping?.trackingNumber ?? ''), [carrier, setCarrier] = useState(shipping?.carrier?.toLowerCase() ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const registered = proof.captureShipping?.registration.state === 'REGISTERED' || proof.shipmentSync?.status === 'READY';
  const connection = trackingConnectionLabel({ hasNumber: Boolean(shipping?.trackingNumber), registered, hasEvents: Boolean(proof.shipmentObservations?.events.length), errorCode: proof.captureShipping?.registration.errorCode });
  async function save() {
    setBusy(true); setError(null);
    try {
      await app.ensureAuth(); await app.client.attachTracking(proof.proofId, value, carrier); await app.refreshProof(proof.proofId);
      setOpen(false); setNotice('Tracking number saved.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Tracking could not be connected. Try again.'); }
    finally { setBusy(false); }
  }
  return <View style={styles.stack}>
    <Text accessibilityLiveRegion="polite" style={[typography.secondary, { color: colors.textSecondary }]}>{connection}</Text>
    {app.role === 'SELLER' && !open ? <Button label={shipping?.trackingNumber ? 'Connect or retry tracking' : 'Add tracking'} variant="secondary" onPress={() => setOpen(true)} /> : null}
    {open ? <View style={[styles.form, { backgroundColor: colors.surface }]}>
      <FormField label="Tracking number or carrier link" value={value} onChangeText={setValue} />
      <Text style={[typography.secondaryStrong, { color: colors.textPrimary }]}>Carrier</Text>
      <View style={styles.carriers} accessibilityRole="radiogroup" accessibilityLabel="Carrier">
        {TRACKING_CARRIERS.map(([key, label]) => {
          const selected = carrier === key;
          return <PressableScale key={key} accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ checked: selected }} onPress={() => setCarrier(key)} style={[styles.carrier, { backgroundColor: selected ? colors.successSoft : colors.surfaceElevated }]}>
            <Text style={[typography.bodyStrong, { color: colors.textPrimary, flexShrink: 1 }]}>{label}</Text>
            <Ionicons name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={22} color={selected ? colors.logoGreen : colors.textSecondary} />
          </PressableScale>;
        })}
        <PressableScale accessibilityRole="radio" accessibilityLabel="Detect automatically" accessibilityState={{ checked: carrier === '' }} onPress={() => setCarrier('')} style={styles.automatic}>
          <Ionicons name={carrier === '' ? 'checkmark-circle' : 'ellipse-outline'} size={20} color={carrier === '' ? colors.logoGreen : colors.textSecondary} />
          <Text style={[typography.secondary, { color: colors.textSecondary }]}>Detect automatically</Text>
        </PressableScale>
      </View>
      <Text style={[typography.finePrint, { color: colors.textSecondary }]}>Added separately from the packing record. This does not change sealed evidence or mean the number was seen in the video.</Text>
      <Button label="Save and connect tracking" loading={busy} disabled={!value.trim()} onPress={() => void save()} />
      <Button label="Cancel" variant="tertiary" onPress={() => setOpen(false)} />
    </View> : null}
    {error ? <Text accessibilityRole="alert" style={[typography.secondary, { color: colors.error }]}>{error}</Text> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={[typography.secondary, { color: colors.textSecondary }]}>{notice}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({
  stack: { gap: 12 }, form: { gap: 12, padding: 16, borderRadius: 16 },
  carriers: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  carrier: { flexBasis: '45%', flexGrow: 1, minHeight: 48, padding: 12, borderRadius: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  automatic: { width: '100%', minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8 },
});
