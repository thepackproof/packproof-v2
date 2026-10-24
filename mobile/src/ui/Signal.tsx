import { useSignalReceipt } from '../experience/signal/use-receipt';
import type { ReactNode } from 'react';
import { Image, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeProvider';
import { signal, signalType } from '../theme/signal';
import { PressableScale, PresentationalReveal } from './motion';
import { Button } from './Button';
import { RecordThumbnail } from './RecordThumbnail';
import { proofDisplayTitle } from '../copy/proof-title';
import { presentationForProof } from '../copy/proof-list';
import type { ProofCollectionItem } from '../v2-api';
import type { SubmissionPresentation } from '../experience/signal/submission-presentation';

export function SignalText({ children, kind = 'body', muted = false, style }: {
  children: ReactNode; kind?: keyof typeof signalType; muted?: boolean; style?: StyleProp<TextStyle>;
}) {
  const { colors } = useTheme();
  return <Text accessibilityRole={['display', 'title', 'heading'].includes(kind) ? 'header' : undefined}
    style={[signalType[kind], { color: muted ? colors.textSecondary : colors.textPrimary }, style]}>{children}</Text>;
}

/** These markers describe available source context, never completeness or chain of custody. */
export function SignalSources({ order, evidence, shipment, inverted = false }: {
  order?: boolean; evidence?: boolean; shipment?: boolean; inverted?: boolean;
}) {
  const { colors } = useTheme();
  const sources = [
    { label: 'Order', available: order, icon: 'receipt-outline' as const },
    { label: 'Evidence', available: evidence, icon: 'videocam-outline' as const },
    { label: 'Shipment', available: shipment, icon: 'cube-outline' as const },
  ].filter(source => source.available);
  if (!sources.length) return null;
  return <View accessibilityLabel={`Available context: ${sources.map(source => source.label).join(', ')}`} style={s.sources}>
    {sources.map((source, index) => <View key={source.label} style={s.sourceGroup}>
      {index > 0 ? <View accessible={false} style={[s.sourceLine, { backgroundColor: inverted ? '#3478FF66' : colors.border }]} /> : null}
      <View style={[s.source, { backgroundColor: inverted ? signal.raisedDark : colors.surfacePressed,
        borderColor: inverted ? '#3478FF66' : colors.border }]}>
        <Ionicons name={source.icon} size={16} color={inverted ? signal.cyan : colors.accentText} />
        <SignalText kind="caption" style={{ color: inverted ? '#FFFFFF' : colors.textPrimary }}>{source.label}</SignalText>
      </View>
    </View>)}
  </View>;
}

export function SignalSteps({ step }: { step: 1 | 2 | 3 }) {
  const { colors } = useTheme();
  return <View style={s.steps} accessibilityLabel={`Step ${step} of 3: ${['Record', 'Review', 'Save'][step - 1]}`}>
    {['Record', 'Review', 'Save'].map((label, index) => <View key={label} style={[s.step,
      { borderTopColor: index + 1 <= step ? colors.primary : colors.border }]}>
      <SignalText kind="caption" muted={index + 1 !== step}>{index + 1 < step ? '\u2713' : index + 1} {label}</SignalText>
    </View>)}
  </View>;
}

export function SignalParcel({ sealed = false, height = 184 }: { sealed?: boolean; height?: number }) {
  return <View style={{ height, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }} accessible={false}>
    <Image source={sealed ? require('../../assets/signal/sealed.png') : require('../../assets/signal/parcel.png')}
      resizeMode="contain" style={{ width: '100%', height: sealed ? 280 : height }} />
  </View>;
}

export function SignalBadge({ state = 'local', children }: { state?: 'local' | 'uploading' | 'saved' | 'attention'; children: ReactNode }) {
  const { colors } = useTheme();
  const color = state === 'saved' ? signal.mintInk : state === 'uploading' ? colors.accentText : state === 'attention' ? colors.warningText : colors.textSecondary;
  const backgroundColor = state === 'saved' ? signal.mint : state === 'uploading' ? colors.accentSoft : state === 'attention' ? colors.warningSoft : colors.surfacePressed;
  const icon = state === 'saved' ? 'checkmark-circle-outline' : state === 'uploading' ? 'cloud-upload-outline' : state === 'attention' ? 'alert-circle-outline' : 'document-outline';
  return <View style={[s.badge, { backgroundColor }]}><Ionicons name={icon} size={15} color={color} />
    <Text style={[signalType.caption, { color, flexShrink: 1 }]}>{children}</Text></View>;
}

export function SignalRow({ proof, onPress, disabled, detail }: { proof: ProofCollectionItem; onPress: () => void; disabled?: boolean; detail?: string }) {
  const { colors } = useTheme();
  const state = presentationForProof(proof);
  const saved = useSignalReceipt(proof.proofId, proof.updatedAt, state.completed);
  const uploading = state.nextAction.type === 'RESUME_UPLOAD' && !state.needsAttention;
  return <PressableScale accessibilityRole="button" accessibilityLabel={`${proofDisplayTitle(proof)}. ${detail || state.displayStatus}`}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[s.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <RecordThumbnail proofId={proof.proofId} derivativeId={proof.thumbnailDerivativeId} />
    <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
      <SignalText kind="strong">{proofDisplayTitle(proof)}</SignalText>
      <SignalText kind="small" muted>{proof.transaction.externalReference || proof.proofId}</SignalText>
      <SignalBadge state={saved ? 'saved' : uploading ? 'uploading' : state.needsAttention ? 'attention' : 'local'}>
        {saved ? 'Saved to PackProof' : state.completed ? 'Proof finalized' : detail || state.displayStatus}
      </SignalBadge>
    </View>
    <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
  </PressableScale>;
}

export function SignalGuide({ onStart, busy, disabled }: { onStart: () => void; busy?: boolean; disabled?: boolean }) {
  const { colors } = useTheme();
  return <View style={{ gap: 24 }}>
    <View style={s.guideHero}>
      <SignalText kind="caption" style={s.darkSecondary}>ONE CONTINUOUS RECORDING</SignalText>
      <SignalText kind="title" style={s.darkText}>From item{ '\n' }to sealed box.</SignalText>
      <SignalText kind="small" style={s.darkSecondary}>Keep the item, packing and final seal in view.</SignalText>
    </View>
    {[
      ['Show the item', 'Make its condition easy to see.'],
      ['Pack it on camera', 'Keep the item and box in view.'],
      ['Finish with the seal', 'Show the closed parcel before stopping.'],
    ].map(([title, body], index) => <View key={title} style={{ flexDirection: 'row', gap: 16 }}>
      <View style={[s.guideNumber, { backgroundColor: colors.accentSoft }]}><SignalText kind="strong" style={{ color: colors.accentText }}>{index + 1}</SignalText></View>
      <View style={{ flex: 1, gap: 4 }}><SignalText kind="strong">{title}</SignalText><SignalText kind="small" muted>{body}</SignalText></View>
    </View>)}
    <Button label="Start recording" icon="arrow-forward" loading={busy} disabled={disabled} onPress={onStart} />
    <SignalText kind="caption" muted style={{ textAlign: 'center' }}>Camera recording has no sound.</SignalText>
  </View>;
}

export function SignalProgress({ presentation }: { presentation: SubmissionPresentation }) {
  const { colors } = useTheme();
  return <View style={{ gap: 24 }}>
    <SignalText kind="title">{presentation.title}</SignalText>
    <SignalText muted>{presentation.detail}</SignalText>
    <View style={[s.progressPanel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <SignalText kind="caption" muted>{presentation.stageLabel}</SignalText>
      <SignalText kind="display">{presentation.headline}</SignalText>
      <View accessibilityRole="progressbar" accessibilityLabel={presentation.stageLabel}
        accessibilityValue={presentation.percent !== null ? { min: 0, max: 100, now: presentation.percent } : undefined}
        style={{ height: 6, backgroundColor: colors.border, borderRadius: 3, overflow: 'hidden' }}>
        {presentation.percent !== null ? <View style={{ height: 6, width: `${presentation.percent}%`, backgroundColor: colors.primary }} /> : null}
      </View>
    </View>
    {[
      [presentation.originalLabel, presentation.originalDetail],
      [presentation.transferLabel, presentation.transferDetail],
      ['Server confirmation', presentation.stage === 'confirming' ? 'Checking the canonical record and preservation receipts.' : 'A canonical saved-Proof receipt has not been confirmed.'],
    ].map(([title, body], index) => <View key={index} style={{ flexDirection: 'row', gap: 16 }}>
      <View style={[s.guideNumber, { backgroundColor: colors.surfacePressed }]}><SignalText kind="small">{index + 1}</SignalText></View>
      <View style={{ flex: 1, gap: 4 }}><SignalText kind="strong">{title}</SignalText><SignalText kind="small" muted>{body}</SignalText></View>
    </View>)}
  </View>;
}
/** Only the existing canonical receipt predicate may mount this presentation. */
export function SignalReceipt({ title, proofId, savedAt, duration, operationKey, onView, onHome }: {
  title: string; proofId: string; savedAt: string; duration: string; operationKey: string; onView: () => void; onHome: () => void;
}) {
  const { colors } = useTheme();
  return <View style={{ gap: 24 }}>
    <PresentationalReveal duration={600} onceKey={`receipt:${operationKey}`}><View style={[s.receipt, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={s.receiptMark}><Ionicons name="checkmark" size={28} color={signal.mintInk} /></View>
      <SignalText kind="caption" muted>CONFIRMED RECEIPT</SignalText>
      <SignalText kind="receipt">Proof saved.</SignalText>
      <SignalText kind="small" muted>Your recording and packing confirmation are together in this Proof.</SignalText>
      <View style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: 20, gap: 12 }}>
        <SignalText kind="subheading">{title}</SignalText>
        <SignalText kind="mono" muted>{proofId}</SignalText>
        <SignalText kind="small" muted>{duration} {'\u00b7'} Original recording</SignalText>
        <SignalText kind="small" muted>{new Date(savedAt).toLocaleString()}</SignalText>
      </View>
    </View>
    </PresentationalReveal><SignalText kind="small" muted>PackProof preserves the evidence submitted. It does not independently verify the parcel contents or decide a dispute.</SignalText>
    <Button label="View your Proof" icon="arrow-forward" onPress={onView} />
    <Button label="Back to Home" variant="tertiary" onPress={onHome} />
  </View>;
}

const s = StyleSheet.create({
  steps: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  step: { flex: 1, borderTopWidth: 3, paddingTop: 8 },
  badge: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8, maxWidth: '100%' },
  row: { flexDirection: 'row', gap: 12, padding: 16, borderWidth: 1, borderRadius: 16, alignItems: 'center', marginBottom: 8 },
  sources: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', rowGap: 8 },
  sourceGroup: { flexDirection: 'row', alignItems: 'center' },
  source: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 8 },
  sourceLine: { height: 1, width: 8 },
  guideHero: { backgroundColor: '#0A172A', borderRadius: 16, padding: 24, gap: 12 },
  darkText: { color: '#FFFFFF' }, darkSecondary: { color: '#A5B6CB' },
  guideNumber: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  progressPanel: { borderWidth: 1, borderRadius: 16, padding: 20, gap: 20 },
  receipt: { borderWidth: 1, borderTopWidth: 4, borderTopColor: '#21D6A0', borderRadius: 16, padding: 24, gap: 16 },
  receiptMark: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#21D6A0', alignItems: 'center', justifyContent: 'center' },
});
