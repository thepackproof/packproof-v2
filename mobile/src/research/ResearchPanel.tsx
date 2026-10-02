import { useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, Text, TextInput, View } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { FEATURE_LABELS, type Feature, type SourceRef } from '../../../packages/evidence-contracts/contracts.mjs';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { Button } from '../ui/Button';
import { ProofEvidencePreview } from '../ui/ProofEvidencePreview';
import { committedRecordEvidence, type RecordEvidence } from '../copy/proof-record';
import { newIdempotencyKey } from '../v2-api';
import { ResearchAnnotations } from './ResearchAnnotations';
import { ResearchArtifacts } from './ResearchArtifacts';
import { researchEnabled } from './isolation';
import { checkedReview, comparisonAvailable, resultLabel, sourceEvidenceId, observationSourceLinks, privacyMask, type ResearchReview } from './review-model';

const features: Feature[] = ['verifiedcapture', 'proofpilot', 'proofsight', 'proofprint', 'prooftwin', 'proofmatch'];
export function ResearchPanel() {
  const app = usePackProof();
  if (!researchEnabled() || !app.proof || !app.session) return null;
  return <ScopedResearchPanel key={`${app.client.apiBaseUrl}:${app.session.userId}:${app.proof.proofId}`} />;
}
function ScopedResearchPanel() {
  const app = usePackProof(), { colors } = useTheme();
  const proof = app.proof!, proofId = proof.proofId;
  const [review, setReview] = useState<ResearchReview | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [consent, setConsent] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [feature, setFeature] = useState<Feature>('proofpilot');
  const [source, setSource] = useState<{ evidence: RecordEvidence; offsetMs: number; polygon?: unknown; associationNote?:string } | null>(null);
  const [mask, setMask] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, [proofId]);
  async function refresh() {
    try { await app.ensureAuth(); const data = checkedReview(await app.client.researchRequest<ResearchReview>(proofId, '/analyses'), proofId); if (alive.current) { setReview(data); setError(null); } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Research details unavailable.'); }
  }
  async function run(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(null);
    try { await app.ensureAuth(); await action(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Research operation could not finish.'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function setParticipation(granted: boolean) {
    await app.client.researchRequest(proofId, '/consents', 'POST', { purpose: 'EXPERIMENTAL_ANALYSIS', version: 'packproof.research-consent.v1', granted }, newIdempotencyKey());
    if (alive.current) setConsent(granted ? 'Research participation recorded for this Proof.' : 'Future research participation withdrawn. Existing evidence is preserved.');
  }
  const chosen = review?.sources.filter(item => selected.includes(item.evidenceId)) ?? [];
  async function request() {
    const body = { ...(feature === 'proofmatch' ? {} : { feature }), evidenceIds: selected, scope: 'research-observations' };
    await app.client.researchRequest(proofId, feature === 'proofmatch' ? '/comparisons' : '/analyses', 'POST', body, newIdempotencyKey());
    await refresh();
  }
  async function requestDerivative() {
    if (chosen.length !== 1) throw new Error('Select one original source for a derivative.');
    await app.client.researchRequest(proofId, '/derivatives', 'POST', {evidenceIds:selected, parameters:{masks:[privacyMask(mask)],kind:chosen[0].mimeType.startsWith('video/')?'video':'still'}}, newIdempotencyKey());
    await refresh();
  }
  async function exportBundle() {
    if (!FileSystem.cacheDirectory || !(await Sharing.isAvailableAsync())) throw new Error('Export unavailable on this device.');
    const file = `${FileSystem.cacheDirectory}packproof-research-${proofId.replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`;
    try {const response = await FileSystem.downloadAsync(app.client.researchContentUrl(proofId, '/export.zip'), file, {headers:app.client.authorizedDownloadHeaders()});
      if(response.status !== 200) throw new Error('Research verification archive unavailable.');
      if(alive.current) await Sharing.shareAsync(file, {mimeType:'application/zip', dialogTitle:'Export research evidence archive'});
    } finally {await FileSystem.deleteAsync(file, {idempotent:true}).catch(()=>undefined);}
  }
  function openSource(ref: SourceRef, offsetMs = ref.frameReference?.offsetMs ?? 0, polygon: unknown = null) {
    const id = sourceEvidenceId(ref.sourceId);
    const record = review?.sources.find(item => item.evidenceId === id);
    const parent = record?.relationship === 'CONCURRENT_SIDECAR' ? record.parentEvidenceId : undefined;
    const evidence = committedRecordEvidence(proof).find(item => item.evidenceId === (parent ?? id));
    if (!evidence) { setError('Source is unavailable in the currently authorized Proof. Refresh the record.'); return; }
    setSource({ evidence, offsetMs: parent ? record?.frameReference?.mediaTimeMs ?? offsetMs : offsetMs, polygon,
      ...(parent ? {associationNote:'This observation uses a native luma sidecar. The player shows its associated original recording time; pixels are not asserted equivalent. Exact sidecar bytes are included in the verification archive.'} : {}) });
  }
  async function exportReview() {
    if (!review || !FileSystem.cacheDirectory || !(await Sharing.isAvailableAsync())) throw new Error('Export unavailable on this device.');
    // Server-derived research report is clearly distinct from a cryptographic verification bundle.
    const file = `${FileSystem.cacheDirectory}packproof-research-${proofId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    try {
      await FileSystem.writeAsStringAsync(file, JSON.stringify({ schemaVersion: 'packproof.research-review-export.v1', proofId,
        warning: 'Research observations; not an independently verified provenance bundle. Original media is omitted.', review }, null, 2));
      if (!alive.current) return;
      await Sharing.shareAsync(file, { mimeType: 'application/json', dialogTitle: 'Export research observations' });
    } finally { await FileSystem.deleteAsync(file, { idempotent: true }).catch(() => undefined); }
  }
  const text = { color: colors.textPrimary }, muted = { color: colors.textSecondary };
  return <View style={{ padding: 16, gap: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 16 }}>
    <Text style={[text, { fontSize: 18, fontWeight: '600' }]}>Research observations</Text>
    <Text style={muted}>Experimental and unqualified. Original evidence remains the record. Signatures describe bytes and session binding; they do not establish scene truth.</Text>
    <Text style={muted}>Opting in permits passive frame selection, native metadata and asynchronous analysis for this Proof. It does not enroll footage in model training. Optional processing can be withdrawn.</Text>
    <Button label="Opt in for this Proof" variant="secondary" disabled={busy} onPress={() => void run(() => setParticipation(true))} />
    <Button label="Withdraw research participation" variant="tertiary" disabled={busy} onPress={() => void run(() => setParticipation(false))} />
    {consent ? <Text accessibilityLiveRegion="polite" style={muted}>{consent}</Text> : null}
    <Text style={text}>Sources</Text>
    {review?.sources.map(item => <Button key={item.evidenceId} label={`${selected.includes(item.evidenceId) ? 'Selected · ' : ''}${item.legId} · ${item.mimeType} · ${item.evidenceId}`} variant="tertiary" onPress={() => setSelected(current => current.includes(item.evidenceId) ? current.filter(id => id !== item.evidenceId) : [...current, item.evidenceId].slice(-2))} />)}
    <ScrollView horizontal accessibilityLabel="Research method" contentContainerStyle={{ gap: 8 }}>{features.map(value => <Button key={value} label={`${feature === value ? 'Selected · ' : ''}${FEATURE_LABELS[value]}`} variant="tertiary" onPress={() => setFeature(value)} />)}</ScrollView>
    <Button label="Request analysis" disabled={busy || proof.status !== 'FINALIZED' || selected.length === 0 || (feature === 'proofmatch' && !comparisonAvailable(chosen))} onPress={() => void run(request)} />
    {proof.status !== 'FINALIZED' ? <Text style={muted}>Save the ordinary Proof before requesting analysis.</Text> : null}
    {feature === 'proofmatch' ? <Text style={muted}>Comparison requires two authorized source recordings from different shipment legs. Missing recipient evidence is unavailable, never a discrepancy.</Text> : null}
    <Text style={text}>Privacy derivative mask in source pixels</Text>
    <TextInput accessibilityLabel="Mask x, y, width, height" placeholder="x, y, width, height" value={mask} onChangeText={setMask} style={{color:colors.textPrimary,borderWidth:1,borderColor:colors.border,padding:12}} />
    <Text style={muted}>The selected rectangle applies to every frame. Audio and metadata are removed. Inspect the complete derivative before approving an export.</Text>
    <Button label="Create derivative for review" variant="secondary" disabled={busy||proof.status!=='FINALIZED'||chosen.length!==1||!mask.trim()} onPress={()=>void run(requestDerivative)} />
    <Button label="Refresh analysis status" variant="secondary" disabled={busy} onPress={() => void run(refresh)} />
    {review?.analyses.map(row => <View key={row.analysisId} style={{ gap: 6, paddingVertical: 10, borderTopWidth: 1, borderColor: colors.border }}>
      <Text style={[text, { fontWeight: '600' }]}>{FEATURE_LABELS[row.feature]} · {resultLabel(row)}</Text>
      <Text style={muted}>Processing: {row.operationalState}{row.errorCode ? ` · ${row.errorCode}` : ''}</Text>
      {row.result ? <>
        <Text style={text}>{row.result.scope}</Text>
        <Text style={muted}>Coverage: {JSON.stringify(row.result.coverage)}</Text>
        {row.result.limitations.map((value, index) => <Text key={index} style={muted}>{value}</Text>)}
        {row.result.sourceRefs.map(ref => <Button key={ref.sourceId} variant="tertiary" label={`Open original source${ref.frameReference?.offsetMs != null ? ` at ${(ref.frameReference.offsetMs / 1000).toFixed(1)}s` : ''}`} onPress={() => openSource(ref)} />)}
        {observationSourceLinks(row.result).map((link, index) => <Button key={index} variant="tertiary" label={`${link.label} · ${(link.offsetMs / 1000).toFixed(1)}s${link.polygon ? ' · marked region' : ''}`} onPress={() => openSource(link.source, link.offsetMs, link.polygon)} />)}
        <ResearchArtifacts envelope={row.result} onSource={openSource} />
        <ResearchAnnotations envelope={row.result} onSource={openSource} />
        <Text selectable style={muted}>{JSON.stringify(row.result.details, null, 2)}</Text>
      </> : null}
    </View>)}
    <Button label="Export source-linked verification archive" variant="secondary" disabled={busy || !review} onPress={() => void run(exportBundle)} />
    <Button label="Export research observations" variant="tertiary" disabled={busy || !review} onPress={() => void run(exportReview)} />
    {error ? <Text accessibilityRole="alert" style={{ color: colors.error }}>{error}</Text> : null}
    <Modal visible={source !== null} animationType="slide" onRequestClose={() => setSource(null)}><ScrollView contentContainerStyle={{ padding: 20, gap: 16, backgroundColor: colors.background }}>
      <Button label="Close source" onPress={() => setSource(null)} />
      {source?.associationNote ? <Text style={muted}>{source.associationNote}</Text> : null}
      {source?.polygon ? <Text style={text}>Observation region in decoded original pixels: {JSON.stringify(source.polygon)}</Text> : null}
      {source ? <ProofEvidencePreview key={`${source.evidence.evidenceId}:${source.offsetMs}`} evidence={source.evidence} title="Preserved original source" bookmarks={[]} initialTime={source.offsetMs / 1000} /> : null}
    </ScrollView></Modal>
  </View>;
}
