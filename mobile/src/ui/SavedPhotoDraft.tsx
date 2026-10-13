import { useState } from 'react';
import { Image, Text, View } from 'react-native';
import * as Sharing from 'expo-sharing';
import { usePackProof } from '../app/PackProofProvider';
import type { PhotoDraft } from '../capture/photo-draft-model';
import { comparisonSlotLabel } from '../copy/custody';
import { useTheme } from '../theme/ThemeProvider';
import { Button } from './Button';

/** Retained drafts stay discoverable even after the permitted workflow step has changed. */
export function SavedPhotoDraft({ draft, openProof = false }: { draft: PhotoDraft; openProof?: boolean }) {
  const app = usePackProof(), { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const complete = draft.phase === 'COMPLETE';
  return <View style={{ gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderColor: colors.divider }}>
    <Text accessibilityRole="header" style={{ color: colors.textPrimary, fontSize: 16, fontWeight: '600' }}>{complete ? 'Saved photo originals' : 'Photos retained on this device'}</Text>
    <Text style={{ color: colors.textSecondary, fontSize: 14, lineHeight: 21 }}>{complete ? 'The server recorded these photos. Local copies are retained.' : draft.phase === 'SUBMITTING' ? 'Check the previous submission before starting another capture. Retrying uses the same photos and request.' : 'These photos belong to an earlier step. They have not been submitted. You can keep or export them.'}</Text>
    {draft.phase === 'SUBMITTING' ? <Button label="Check photo save" disabled={app.busy || app.offline} onPress={() => void app.commitGradingCapture(draft)} /> : null}
    {openProof ? <Button label="Open Proof" variant="secondary" disabled={app.busy} onPress={() => void app.run(() => app.openProof(draft.proofId))} /> : null}
    <Button label={expanded ? 'Hide originals' : `View originals · ${draft.slots.length}`} variant="tertiary" onPress={() => setExpanded(!expanded)} />
    {expanded ? draft.slots.map(slot => <View key={slot.uploadKey} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
      <Image source={{ uri: slot.uri }} accessibilityLabel={`${comparisonSlotLabel(slot.slot)} original`} style={{ width: 60, height: 72, resizeMode: 'contain' }} />
      <Button label={`Export ${comparisonSlotLabel(slot.slot)}`} variant="tertiary" onPress={() => void app.run(async () => { if (!await Sharing.isAvailableAsync()) throw new Error('Sharing is unavailable on this device. The original is retained.'); await Sharing.shareAsync(slot.uri, { mimeType: slot.contentType, dialogTitle: 'Save original photo' }); })} />
    </View>) : null}
  </View>;
}
