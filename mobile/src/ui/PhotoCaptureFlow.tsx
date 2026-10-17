import { StateTransition } from './motion';
import { useRef, useState } from 'react';
import { Image, Linking, StyleSheet, Text, View } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import { captureGradingPhoto } from '../capture';
import { photoContextKey, photoDraftContext, photoDraftRemaining } from '../capture/photo-draft-model';
import { captureSlots, comparisonSlotLabel } from '../copy/custody';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { Button } from './Button';
import { recordMobileUxEvent } from '../analytics/mobile-ux-events';

/** The native camera provides Retake / Use photo. Selecting a photo saves it durably before advancing. */
export function PhotoCaptureFlow() {
  const app = usePackProof(), { colors } = useTheme();
  const [taking, setTaking] = useState(false), [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const context = app.proof && app.session ? photoDraftContext(app.proof, app.session.userId, app.apiBaseUrl) : null;
  if (!app.proof) return null;
  if (!context) return <Text style={[styles.copy, { color: colors.textSecondary }]}>This capture step is waiting for the required participant. You can review the current record below.</Text>;
  const slots = captureSlots(context.recipe);
  const draft = app.photoDrafts.find(row => photoContextKey(row) === photoContextKey(context) && row.phase !== 'COMPLETE');
  const next = slots.find(slot => slot.required && !draft?.slots.some(row => row.slot === slot.slot));
  const remaining = draft ? photoDraftRemaining(draft) : slots.filter(s => s.required).length;
  const started = draft?.phase === 'SUBMITTING';
  const submitting = app.photoSubmissionId === draft?.id;
  const busy = app.busy || taking || submitting;
  async function take(slot: string) {
    if (lock.current || !context) return;
    lock.current = true; setTaking(true); setError(null);
    try {
      // ImagePicker exposes a launch request, not a native camera-ready callback.
      recordMobileUxEvent('photo_requested');
      const selected = await captureGradingPhoto();
      if (selected) await app.retainGradingPhoto(context, { ...selected, slot });
      else recordMobileUxEvent('photo_cancelled');
    } catch (reason) { recordMobileUxEvent('photo_intervention'); setError(reason instanceof Error ? reason.message : 'The camera could not open. Try again.'); }
    finally { lock.current = false; setTaking(false); }
  }
  return <View style={styles.flow}>
    <StateTransition eventKey={[context.proofId,context.assetId,remaining,draft?.phase,draft?.slots.filter(s=>s.sha256).length].join(':')}><Text accessibilityRole="header" style={[styles.title, { color: colors.textPrimary }]}>{started ? (submitting ? 'Saving item photos' : 'Checking the item step') : next ? comparisonSlotLabel(next.slot) + ' photo' : 'Review your photos'}</Text>
    <Text accessibilityLiveRegion="polite" style={[styles.copy, { color: colors.textSecondary }]}>{app.proof.nextAction?.title}{' · '}{remaining ? `${remaining} ${remaining === 1 ? 'photo' : 'photos'} remaining` : 'All required views selected'}</Text>
    </StateTransition>
    <View style={styles.progress}>{slots.map(slot => <Text key={slot.slot} style={[styles.copy, { color: draft?.slots.some(row => row.slot === slot.slot) ? colors.successText : colors.textSecondary }]}>{comparisonSlotLabel(slot.slot)}{draft?.slots.some(row => row.slot === slot.slot) ? ' ✓' : ''}</Text>)}</View>
    {next && !started ? <><Text style={[styles.copy, { color: colors.textSecondary }]}>Keep the full item in frame. Choose Use photo in the camera to continue.</Text><Button label="Open camera" icon="camera-outline" loading={taking} disabled={app.busy} onPress={() => void take(next.slot)} /></> : null}
    {draft?.slots.map(row => <View key={row.uploadKey} style={[styles.photo, { borderColor: colors.divider }]}>
      <Image source={{ uri: row.uri }} accessibilityLabel={`${comparisonSlotLabel(row.slot)} selected photo`} style={styles.thumbnail} />
      <View style={styles.photoCopy}><Text style={[typography.bodyStrong, { color: colors.textPrimary }]}>{comparisonSlotLabel(row.slot)} ✓</Text><Text style={[styles.copy, { color: colors.textSecondary }]}>{row.sha256 ? 'Saved to PackProof · item step pending' : 'Saved on device'}</Text></View>
      {!started ? <Button label="Retake" variant="tertiary" disabled={busy} onPress={() => void take(row.slot)} /> : null}
    </View>)}
    {!remaining && draft ? <><Button label={submitting ? 'Saving item photos' : started ? 'Check photo submission' : 'Save item photos'} disabled={busy || app.offline} loading={submitting} onPress={() => void app.commitGradingCapture(draft)} /><Text style={[styles.copy, { color: colors.textSecondary }]}>{app.offline ? 'Reconnect to submit. Your selected photos remain on this device.' : draft.retry?.message ?? 'Originals stay on this device while PackProof checks and records them. The next task appears when the item step is acknowledged.'}</Text></> : null}
    {error ? <><Text accessibilityRole="alert" style={[styles.copy, { color: colors.error }]}>{error}</Text><Button label="Open device settings" variant="tertiary" onPress={() => void Linking.openSettings()} /></> : null}
  </View>;
}
const styles = StyleSheet.create({ flow: { gap: 12 }, title: { ...typography.sectionTitle, fontSize: 20, lineHeight: 28 }, copy: { ...typography.secondary }, progress: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 }, photo: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, paddingVertical: 8, borderBottomWidth: 1 }, thumbnail: { width: 56, height: 64, borderRadius: 8, resizeMode: 'contain' }, photoCopy: { flex: 1, minWidth: 100, gap: 4 } });
