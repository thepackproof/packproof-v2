import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { signal } from '../theme/signal';
import { committedRecordEvidence, recordEvidenceKey, recordEvidenceLabel, type RecordEvidence } from '../copy/proof-record';
import { connectedRecordEvents, connectedRecordSources, originalForRecordEvent, recordEventIdentity, type RecordSource } from '../copy/eim-record';
import { chronologyCategoryLabel, humanChronologyTitle } from '../copy/chronology';
import { presentationForProof } from '../copy/proof-list';
import { hasSignalReceipt } from '../experience/signal/receipt';
import type { ChronologyEntry } from '../v2-api';
import { SignalText, SignalBadge } from './Signal';
import { ProofEvidencePreview } from './ProofEvidencePreview';
import { ProofRecord } from './ProofRecord';
import { Button } from './Button';
import { PressableScale, StateTransition } from './motion';
import { RestoringScrollView } from './RestoringScrollView';
import { SharingScreen } from '../screens/SharingScreen';
import { SELLER_SHIPPING_STATEMENT } from '../attestation/statement';

export function SignalProofRecord({ action }: { action: ReactNode }) {
  const app = usePackProof();
  const owner = JSON.stringify([app.apiBaseUrl, app.session?.userId, app.proof?.proofId]);
  return <ConnectedRecord key={owner} owner={owner} action={action} />;
}

function ConnectedRecord({ action, owner }: { action: ReactNode; owner: string }) {
  const app = usePackProof(), { colors } = useTheme(), proof = app.proof!;
  const view = useRef(app.readProofRecordView(proof.proofId));
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function currentOwner() {
    if (!mounted.current || !app.session) return false;
    try { app.client.assertCaptureAccount(app.session.userId, app.apiBaseUrl); return true; } catch { return false; }
  }
  const [details, setDetails] = useState(false), [sharing, setSharing] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [evidenceKey, setEvidenceKey] = useState<string | null>(() => view.current.selectedEvidenceId
    ? view.current.selectedEvidenceStageId ? `${view.current.selectedEvidenceStageId}:${view.current.selectedEvidenceId}` : view.current.selectedEvidenceId
    : null);
  const [source, setSource] = useState<RecordSource>(view.current.connectedRecord?.source ?? 'ALL');
  const [eventIdentity, setEventIdentity] = useState<string | null>(view.current.connectedRecord?.eventIdentity ?? null);
  const evidence = committedRecordEvidence(proof);
  const primary = evidence.find(row => !row.stageId && row.contentType?.startsWith('video/')) || evidence[0];
  const selected = evidence.find(row => recordEvidenceKey(row) === evidenceKey) || primary;
  const presentation = presentationForProof(proof, app.role);
  const receiptIdentity = JSON.stringify([owner, proof.version, primary?.evidenceId]);
  const sources = connectedRecordSources(proof, evidence);
  const events = connectedRecordEvents(proof.chronology ?? [], source);
  const selectedEvent = events.find(row => recordEventIdentity(row) === eventIdentity);
  const recentEvents = events.slice(-8);
  const visibleEvents = selectedEvent && !recentEvents.includes(selectedEvent)
    ? [selectedEvent, ...recentEvents.slice(-7)]
    : recentEvents;
  const statement = proof.attestations?.find(row => row.statement === 'PACKED_DESCRIBED_ITEM' &&
    row.relatedEvidenceId === selected?.evidenceId && !selected?.stageId);

  useEffect(() => {
    let active = true;
    setSaved(null);
    if (primary && currentOwner()) void app.client.getProofRecovery(proof.proofId).then(recovery => {
      if (active && currentOwner() && hasSignalReceipt(proof, recovery, { proofId: proof.proofId, evidenceId: primary.evidenceId })) setSaved(receiptIdentity);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [receiptIdentity, app.client]);

  function selectEvidence(next: RecordEvidence) {
    if (!currentOwner()) return;
    setEvidenceKey(recordEvidenceKey(next));
    view.current = { ...view.current, selectedEvidenceId: next.evidenceId, selectedEvidenceStageId: next.stageId ?? null };
    app.saveProofRecordView(proof.proofId, view.current);
  }
  function updateSelection(nextSource: RecordSource, nextEvent: string | null) {
    if (!currentOwner()) return;
    setSource(nextSource); setEventIdentity(nextEvent);
    view.current = { ...view.current, connectedRecord: { offset: view.current.connectedRecord?.offset ?? 0, source: nextSource, eventIdentity: nextEvent } };
    app.saveProofRecordView(proof.proofId, view.current);
  }
  function selectEvent(next: ChronologyEntry) {
    updateSelection(source, recordEventIdentity(next));
    const original = originalForRecordEvent(next, evidence, proof.events);
    if (original) selectEvidence(original);
  }
  function saveOffset(offset: number) {
    if (!currentOwner()) return;
    view.current = { ...view.current, connectedRecord: { offset, source, eventIdentity } };
    app.saveProofRecordView(proof.proofId, view.current);
  }
  function savePlayback(key: string, seconds: number) {
    if (!currentOwner() || !Number.isFinite(seconds) || seconds < 0) return;
    view.current = { ...view.current, playbackTimes: { ...view.current.playbackTimes, [key]: seconds } };
    app.saveProofRecordView(proof.proofId, view.current);
  }
  if (details) return <View style={styles.details}><Button label="Back to your Proof" variant="tertiary" onPress={() => { view.current = app.readProofRecordView(proof.proofId); const next = evidence.find(row => row.evidenceId === view.current.selectedEvidenceId && (row.stageId ?? null) === (view.current.selectedEvidenceStageId ?? null)); if (next) setEvidenceKey(recordEvidenceKey(next)); setDetails(false); }} /><ProofRecord key={proof.proofId} statusLabel={presentation.displayStatus} action={action} /></View>;

  return <>
    <RestoringScrollView contentContainerStyle={styles.content} initialOffsetY={view.current.connectedRecord?.offset ?? 0} onScrollOffset={saveOffset} keyboardShouldPersistTaps="handled">
      <View style={[styles.identity, { backgroundColor: signal.navy }]}>
        <SignalText kind="mono" style={{ color: signal.cyan }}>CONNECTED PROOF RECORD</SignalText>
        <SignalText kind="title" style={{ color: '#FFFFFF' }}>{proof.transaction.itemTitle || 'Packing record'}</SignalText>
        <SignalText kind="small" style={{ color: signal.darkSecondary }}>{proof.transaction.externalReference || proof.proofId}</SignalText>
        <View style={styles.sources} accessibilityLabel="Sources available in this record">
          {sources.map((item, index) => <View key={item.key} style={styles.sourceSlot}>
            {index > 0 ? <View style={[styles.connection, { backgroundColor: signal.cyan }]} /> : null}
            <View style={styles.sourceButton}><PressableScale accessibilityRole="button" accessibilityLabel={`${item.label}: ${item.detail}. Filter history.`} accessibilityState={{ selected: source === item.key }} onPress={() => { updateSelection(source === item.key ? 'ALL' : item.key, null); }} style={[styles.source, { borderColor: source === item.key ? signal.cyan : signal.raisedDark, backgroundColor: signal.raisedDark }]}>
              <Ionicons name={item.key === 'COMMERCE' ? 'receipt-outline' : item.key === 'SHIPMENT' ? 'cube-outline' : 'videocam-outline'} size={20} color={signal.cyan} />
              <SignalText kind="caption" style={{ color: '#FFFFFF', textAlign: 'center' }}>{item.label}</SignalText>
            </PressableScale></View>
          </View>)}
        </View>
      </View>
      <SignalBadge state={saved === receiptIdentity ? 'saved' : 'local'}>{saved === receiptIdentity ? 'Saved to PackProof' : proof.status === 'FINALIZED' ? 'Proof finalized' : presentation.displayStatus}</SignalBadge>
      {proof.transaction.itemDescription ? <SignalText muted>{proof.transaction.itemDescription}</SignalText> : null}
      {action}
      <View style={styles.section}>
        <SignalText kind="heading">Original evidence</SignalText>
        {evidence.length > 1 ? <View style={styles.evidenceChoices} accessibilityRole="tablist" accessibilityLabel="Original evidence">
          {evidence.map((item, index) => <PressableScale key={recordEvidenceKey(item)} accessibilityRole="tab" accessibilityState={{ selected: recordEvidenceKey(item) === (selected && recordEvidenceKey(selected)) }} onPress={() => selectEvidence(item)} style={[styles.evidenceChoice, { borderColor: recordEvidenceKey(item) === (selected && recordEvidenceKey(selected)) ? colors.primary : colors.border, backgroundColor: colors.surface }]}><SignalText kind="small">{recordEvidenceLabel(item)} {index + 1}</SignalText></PressableScale>)}
        </View> : null}
        {selected ? <>
          <StateTransition eventKey={recordEvidenceKey(selected)}><ProofEvidencePreview key={recordEvidenceKey(selected)} evidence={selected} title={recordEvidenceLabel(selected)} bookmarks={[]} initialTime={view.current.playbackTimes?.[recordEvidenceKey(selected)] ?? 0} onTime={seconds => savePlayback(recordEvidenceKey(selected), seconds)} /></StateTransition>
          <SignalText kind="small" muted>{recordEvidenceLabel(selected)} · Original file. The record preserves this source; it does not independently verify the physical item.</SignalText>
        </> : <SignalText muted>No committed original is available in this Proof yet.</SignalText>}
      </View>
      {statement ? <View style={[styles.statement, { borderColor: colors.border }]}><SignalText kind="mono" muted>PARTICIPANT STATEMENT</SignalText><SignalText kind="strong">{SELLER_SHIPPING_STATEMENT}</SignalText><SignalText kind="small" muted>Recorded {statement.createdAt}</SignalText></View> : null}
      <View style={styles.section}>
        <View style={styles.historyHeading}><SignalText kind="heading">Connected history</SignalText>{source !== 'ALL' ? <Button label="All sources" variant="tertiary" onPress={() => { updateSelection('ALL', null); }} /> : null}</View>
        <SignalText kind="small" muted>Each source keeps its own identity. Connections show how records relate.</SignalText>
        {events.length > 8 ? <SignalText kind="caption" muted>Showing {visibleEvents.length} of {events.length} events. Full history remains available below.</SignalText> : null}
        {visibleEvents.map((item, index) => {
          const identity = recordEventIdentity(item);
          const active = identity === eventIdentity;
          return <View key={identity} style={styles.eventRow}>
            <View style={styles.rail}><View style={[styles.dot, { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.accentSoft : colors.surface }]} /><View style={[styles.line, { backgroundColor: index === visibleEvents.length - 1 ? 'transparent' : colors.border }]} /></View>
            <View style={styles.eventContent}>
              <PressableScale accessibilityRole="button" accessibilityState={{ expanded: active }} accessibilityLabel={`${humanChronologyTitle(item.eventType, item.title)}. ${item.occurredAt}. ${chronologyCategoryLabel(item.category, item.source, item.provider, item.eventType)}. Inspect source.`} onPress={() => active ? updateSelection(source, null) : selectEvent(item)} style={[styles.event, { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.accentSoft : colors.surface }]}>
                <SignalText kind="strong">{humanChronologyTitle(item.eventType, item.title)}</SignalText><SignalText kind="small" muted>{chronologyCategoryLabel(item.category, item.source, item.provider, item.eventType)}</SignalText><SignalText kind="caption" muted>{item.occurredAt || 'Time unavailable'}</SignalText>
              </PressableScale>
              <StateTransition eventKey={active ? identity : 'closed'}>{active ? <SourceInspector event={item} related={originalForRecordEvent(item, evidence, proof.events)} onOpenDetails={() => { if (!currentOwner()) return; app.setSelectedEvent(item); app.go('event'); }} /> : null}</StateTransition>
            </View>
          </View>;
        })}
        {!events.length ? <SignalText muted>{source === 'ALL' ? 'Source history is not available yet. Refresh this Proof or open its full record details.' : 'This source has no chronology events available.'}</SignalText> : null}
      </View>
      {presentation.share.available ? <Button label="Share Proof" icon="share-outline" onPress={() => { if (currentOwner()) setSharing(true); }} /> : null}
      <Button label="Recording history and details" variant="secondary" onPress={() => setDetails(true)} />
      <SignalText kind="caption" muted>{proof.proofId}</SignalText>
    </RestoringScrollView>
    {sharing ? <SharingScreen asSheet onClose={() => setSharing(false)} /> : null}
  </>;
}

function SourceInspector({ event, related, onOpenDetails }: { event: ChronologyEntry; related?: RecordEvidence; onOpenDetails: () => void }) {
  const app = usePackProof(), { colors } = useTheme();
  const shipment = event.category === 'SHIPMENT' ? app.proof?.shipmentObservations?.events.find(row => (row.id === event.id || row.id === event.relatedEntityId) && row.source === event.source && row.provider === event.provider) : undefined;
  return <View accessibilityLabel="Selected source details" style={[styles.inspector, { borderColor: colors.border, backgroundColor: colors.surfaceElevated }]}>
    <SignalText kind="mono" muted>SOURCE DETAILS</SignalText>
    <SignalText kind="small">Source: {event.source || 'Not provided'}{event.provider ? ` · ${event.provider}` : ''}</SignalText>
    <SignalText kind="small" muted>Occurred: {event.occurredAt || 'Time unavailable'}</SignalText>
    {shipment?.observedAt ? <SignalText kind="small" muted>Received by PackProof: {shipment.observedAt}</SignalText> : null}
    {event.description ? <SignalText kind="small">{event.description}</SignalText> : null}
    <SignalText kind="small" muted>{related ? `Associated original: ${recordEvidenceLabel(related)}. It is selected above.` : 'No original evidence is directly associated with this event.'}</SignalText>
    {event.category === 'SHIPMENT' ? <SignalText kind="caption" muted>Shipment observations are reported by their source and remain separate from the frozen evidence core.</SignalText> : null}
    <Button label="Exact event details" variant="tertiary" onPress={onOpenDetails} />
  </View>;
}

const styles = StyleSheet.create({
  details: { flex: 1, gap: 12 }, content: { gap: 24, paddingBottom: 32 },
  identity: { borderRadius: 20, padding: 20, gap: 12 },
  sources: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  sourceSlot: { flex: 1, minWidth: 72, flexDirection: 'row', alignItems: 'center', gap: 8 },
  sourceButton: { flex: 1 },
  source: { minHeight: 72, borderWidth: 1, borderRadius: 12, padding: 8, gap: 6, justifyContent: 'center', alignItems: 'center' },
  connection: { height: 1, width: 8, opacity: 0.65 }, section: { gap: 12 },
  evidenceChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, evidenceChoice: { minHeight: 48, justifyContent: 'center', borderWidth: 1, borderRadius: 8, padding: 12 },
  statement: { borderTopWidth: 1, borderBottomWidth: 1, paddingVertical: 20, gap: 8 },
  historyHeading: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' },
  eventRow: { flexDirection: 'row', gap: 12 }, rail: { width: 14, alignItems: 'center', paddingTop: 18 },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2 }, line: { width: 1, flex: 1, minHeight: 20, marginTop: 6 },
  eventContent: { flex: 1, gap: 8, paddingBottom: 8 }, event: { minHeight: 72, padding: 16, gap: 5, borderRadius: 16, borderWidth: 1 },
  inspector: { borderRadius: 12, borderWidth: 1, padding: 16, gap: 10 },
});
