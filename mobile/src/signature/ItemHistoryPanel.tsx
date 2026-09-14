import { useEffect, useRef, useState } from 'react';
import { AppState, Share, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { PackProofV2Client, ProofView } from '../v2-api';
import { Button } from '../ui/Button';
import { FormField } from '../ui/FormField';
import { InfoCard } from '../ui/ProofCard';
import { useTheme } from '../theme/ThemeProvider';
import { SelectionRow } from './SelectionRow';
import { approveHistorySelection, assertCurrent, historyApprovalBody, historyFrom, historyShareId, incomingHistoryFrom, scoped, type HistoryEntry, type HistoryPreview, type ReviewedHistory } from './workflows';

function HistoryContents({ entries, limitations = [] }: { entries: HistoryEntry[]; limitations?: string[] }) {
  const { colors } = useTheme();
  return <View style={{ gap: 12 }}>{entries.map(entry => <View key={entry.linkId} style={{ gap: 6, padding: 12, borderWidth: 1, borderRadius: 12, borderColor: colors.border }}>
    <Text style={{ color: colors.textPrimary, fontWeight: '700' }}>{entry.state.replaceAll('_', ' ')}</Text>
    <Text selectable style={{ color: colors.textSecondary }}>{entry.note ?? entry.reason ?? 'No participant note supplied.'}</Text>
    {entry.events?.map(event => <View key={event.eventId} style={{ gap: 4, borderLeftWidth: 2, borderColor: colors.border, paddingLeft: 10 }}><Text style={{ color: colors.textPrimary }}>{event.state.replaceAll('_', ' ')} · {new Date(event.createdAt).toLocaleString()}</Text><Text selectable style={{ color: colors.textSecondary }}>{event.note}</Text></View>)}
  </View>)}{limitations.map((limit, index) => <Text key={index} style={{ color: colors.textSecondary, fontSize: 12, lineHeight: 17 }}>{limit}</Text>)}</View>;
}

type HistoryPanelProps = {
  api: PackProofV2Client; proof: ProofView; userId: string; history: unknown; enabled: boolean;
  reload: () => Promise<void>; openProof: (id: string) => Promise<void>; ensureAuth: () => Promise<void>;
  isCurrent: () => boolean; incomingShareId?: string | null;
};
export function ItemHistoryPanel(props: HistoryPanelProps) {
  const { colors } = useTheme();
  try { historyFrom(props.history); }
  catch { return <InfoCard><Text accessibilityRole="alert" style={{ color: colors.error }}>Item history could not be read. Refresh this Proof to try again.</Text></InfoCard>; }
  return <HistoryPanelContents {...props} />;
}
function HistoryPanelContents({ api, proof, userId, history, enabled, reload, openProof, ensureAuth, isCurrent, incomingShareId }: HistoryPanelProps) {
  const { colors } = useTheme(), proofId = proof.proofId;
  const data = historyFrom(history), assets = proof.assets ?? [];
  const canConsent = proof.participants.some(participant => participant.userId === userId && participant.role === 'SELLER');
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [previousOptions, setPreviousOptions] = useState<Array<{ proofId: string; title: string }>>([]);
  const [previousProof, setPreviousProof] = useState(''), [previousAssets, setPreviousAssets] = useState<Array<{ assetId: string; label: string }>>([]);
  const [previousAsset, setPreviousAsset] = useState(''), [asset, setAsset] = useState(assets[0]?.assetId ?? ''), [note, setNote] = useState('');
  const [eventNotes, setEventNotes] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<string[]>([]), [query, setQuery] = useState(''), [recipient, setRecipient] = useState('');
  const [users, setUsers] = useState<Array<{ userId: string; username: string | null; displayName: string | null }>>([]);
  const [preview, setPreview] = useState<ReviewedHistory | null>(null), [showExact, setShowExact] = useState(false);
  const [shared, setShared] = useState<{ shareId: string; path: string } | null>(null);
  const [incomingInput, setIncomingInput] = useState(''), [incoming, setIncoming] = useState<{ preview: HistoryPreview; changedSinceApproval: boolean } | null>(null);
  const mounted = useRef(true), busyRef = useRef(false), selectionVersion = useRef(0), currentRef = useRef(isCurrent); currentRef.current = isCurrent;
  const current = () => {
    if (!mounted.current || !currentRef.current()) return false;
    try { api.assertCaptureAccount(userId, api.apiBaseUrl); return true; } catch { return false; }
  };
  const active = () => current() && AppState.currentState === 'active';
  const text = { color: colors.textSecondary, fontSize: 15, lineHeight: 21 };
  function invalidate() { selectionVersion.current++; setPreview(null); setShared(null); setIncoming(null); setShowExact(false); }
  async function run(action: () => Promise<void>) {
    if (busyRef.current || !current()) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await scoped(active, ensureAuth); await action(); }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'Item history is unavailable.'); }
    finally { busyRef.current = false; if (current()) setBusy(false); }
  }
  const request = <T,>(path: string, method = 'GET', body?: unknown) => scoped(active, () => api.signatureRequest<T>(proofId, path, method, body));
  async function loadIncoming(value: string) {
    setIncoming(null);
    const revision = selectionVersion.current;
    const id = historyShareId(value, proofId);
    const response = await request<unknown>(`/history/shares/${encodeURIComponent(id)}`);
    if (revision === selectionVersion.current) setIncoming(incomingHistoryFrom(response, proofId));
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; selectionVersion.current++; }; }, []);
  useEffect(() => { setPreview(null); setIncoming(null); selectionVersion.current++; setSelection(ids => ids.filter(id => data.entries.some(entry => entry.linkId === id && entry.state !== 'UNAVAILABLE'))); }, [JSON.stringify(data.entries), data.optedIn]);
  useEffect(() => { if (incomingShareId) void run(() => loadIncoming(incomingShareId)); }, [incomingShareId, proofId]);

  return <View style={{ gap: 16 }}>
    {error ? <Text accessibilityRole="alert" style={{ color: colors.error }}>{error}</Text> : null}
    <InfoCard>
      <Text accessibilityRole="header" style={{ color: colors.textPrimary, fontSize: 20, fontWeight: '700' }}>Item history</Text>
      <Text style={text}>Link records you can access to describe an item’s partial history. A link is a participant statement; matching identifiers do not authenticate an item.</Text>
      <SelectionRow label="Allow this Proof to participate in item history" selected={data.optedIn} disabled={busy || !canConsent || (!enabled && !data.optedIn)} onPress={() => void run(async () => { await request('/history/consent', 'POST', { optIn: !data.optedIn }); invalidate(); await scoped(active, reload); })} />
      {!canConsent ? <Text style={text}>The seller controls this Proof’s history consent.</Text> : null}
      {!enabled ? <Text style={text}>New history links are unavailable from this server. Existing consent can still be withdrawn.</Text> : null}
      {data.optedIn && enabled ? <>
        <Button label="Choose an earlier authorized Proof" variant="secondary" disabled={busy} onPress={() => void run(async () => { const response = await scoped(active, () => api.listMyProofs()); setPreviousOptions(response.proofs.filter(row => row.proofId !== proofId).map(row => ({ proofId: row.proofId, title: row.transaction?.itemTitle ?? 'Shipment' }))); })} />
        {previousOptions.map(row => <SelectionRow key={row.proofId} selected={previousProof === row.proofId} label={`${row.title} · ${row.proofId.slice(-8)}`} disabled={busy} onPress={() => void run(async () => { setPreviousProof(row.proofId); setPreviousAsset(''); setPreviousAssets([]); const previous = await scoped(active, () => api.getProof(row.proofId)); if (previous.proofId !== row.proofId) throw new Error('The earlier Proof could not be verified.'); setPreviousAssets((previous.assets ?? []).map(item => ({ assetId: item.assetId, label: item.label }))); })} />)}
        {previousProof ? <Text style={{ color: colors.textPrimary, fontWeight: '700' }}>Earlier item</Text> : null}
        {previousAssets.map((item, index) => <SelectionRow key={item.assetId} label={item.label || `Earlier item ${index + 1}`} selected={previousAsset === item.assetId} disabled={busy} onPress={() => setPreviousAsset(item.assetId)} />)}
        {previousProof && !previousAssets.length ? <Text style={text}>That Proof has no item reference available to link.</Text> : null}
        <Text style={{ color: colors.textPrimary, fontWeight: '700' }}>Item in this Proof</Text>
        {assets.map((item, index) => <SelectionRow key={item.assetId} label={item.label || `Item ${index + 1}`} selected={asset === item.assetId} disabled={busy} onPress={() => setAsset(item.assetId)} />)}
        {!assets.length ? <Text style={text}>This Proof needs an existing item reference before its history can be linked.</Text> : null}
        <FormField label="Why you believe these records refer to the same item" value={note} multiline editable={!busy} onChangeText={value => setNote(value.slice(0, 2000))} />
        <Button label="Propose history link" disabled={busy || !previousProof || !previousAsset || !asset || !note.trim()} onPress={() => void run(async () => { await request('/history', 'POST', { previousProofId: previousProof, previousAssetId: previousAsset, assetId: asset, note: note.trim() }); setNote(''); await scoped(active, reload); })} />
        <Text style={text}>Both Proofs must independently opt in, and each selected item must already belong to its Proof.</Text>
      </> : null}
    </InfoCard>
    {data.entries.map(entry => <InfoCard key={entry.linkId}>
      <HistoryContents entries={[entry]} />
      {entry.previousProofId ? <Button label="Open the linked Proof" variant="secondary" disabled={busy} onPress={() => void run(async () => { const id = entry.previousProofId === proofId ? entry.proofId : entry.previousProofId; if (!id) throw new Error('The linked Proof is unavailable.'); assertCurrent(active); await openProof(id); })} /> : null}
      {entry.state !== 'UNAVAILABLE' && enabled ? <>
        <FormField label="Reason for your response or correction" value={eventNotes[entry.linkId] ?? ''} multiline editable={!busy} onChangeText={value => setEventNotes(values => ({ ...values, [entry.linkId]: value.slice(0, 2000) }))} />
        {([['CORROBORATED', 'Acknowledge this link'], ['DISPUTED', 'Dispute this link'], ['CORRECTED', 'Append a correction']] as const).map(([state, label]) => <Button key={state} label={label} variant="secondary" disabled={busy || !eventNotes[entry.linkId]?.trim()} onPress={() => void run(async () => { await request(`/history/${encodeURIComponent(entry.linkId)}/events`, 'POST', { state, note: eventNotes[entry.linkId].trim() }); setEventNotes(values => ({ ...values, [entry.linkId]: '' })); await scoped(active, reload); })} />)}
        <Text style={{ ...text, fontSize: 12 }}>Responses append to this history; earlier statements remain visible.</Text>
      </> : null}
    </InfoCard>)}
    <InfoCard>
      <Text accessibilityRole="header" style={{ color: colors.textPrimary, fontSize: 18, fontWeight: '700' }}>Share selected history</Text>
      <Text style={text}>Choose existing links and an account. Both accounts must already have permission and consent for every source. This handoff grants no recording access.</Text>
      {data.entries.filter(entry => entry.state !== 'UNAVAILABLE').map(entry => <SelectionRow key={entry.linkId} selected={selection.includes(entry.linkId)} label={entry.note ?? entry.state.replaceAll('_', ' ')} disabled={busy || !enabled} onPress={() => { invalidate(); setSelection(ids => ids.includes(entry.linkId) ? ids.filter(id => id !== entry.linkId) : [...ids, entry.linkId]); }} />)}
      <FormField label="Recipient’s PackProof username" value={query} editable={!busy} onChangeText={value => { setQuery(value.slice(0, 120)); setUsers([]); setRecipient(''); invalidate(); }} />
      <Button label="Find account" variant="secondary" disabled={busy || query.trim().length < 3 || !enabled} onPress={() => void run(async () => { const response = await scoped(active, () => api.searchUsers(query.trim())); setUsers(response.users); })} />
      {users.map(user => <SelectionRow key={user.userId} selected={recipient === user.userId} label={`${user.displayName ?? user.username ?? 'PackProof account'}${user.username ? ` · @${user.username}` : ''}`} disabled={busy} onPress={() => { invalidate(); setRecipient(user.userId); }} />)}
      <Button label="Preview selected entries" disabled={busy || !recipient || !selection.length || selection.length > 25 || !enabled} onPress={() => void run(async () => { const revision = selectionVersion.current; const response = await request<ReviewedHistory>('/history/preview', 'POST', { recipientUserId: recipient, linkIds: selection }); historyApprovalBody(response, proofId, recipient, selection); if (revision === selectionVersion.current) setPreview(response); })} />
      {preview ? <>
        <Text accessibilityRole="header" style={{ color: colors.textPrimary, fontWeight: '700' }}>Exact selected history preview</Text>
        <HistoryContents entries={preview.preview.entries} limitations={preview.preview.limitations} />
        <Button label={showExact ? 'Hide exact selected contents' : 'Inspect exact selected contents'} variant="tertiary" onPress={() => setShowExact(!showExact)} />
        {showExact ? <Text selectable style={{ ...text, fontSize: 12 }}>{JSON.stringify(preview.preview, null, 2)}{`\nSHA-256: ${preview.previewSha256}`}</Text> : null}
        <Button label="Approve this selection and create handoff" disabled={busy} onPress={() => void run(async () => { const revision = selectionVersion.current; setShared(await approveHistorySelection({ reviewed: preview, proofId, recipientUserId: recipient, linkIds: selection, current: () => active() && revision === selectionVersion.current, create: body => request('/history/share', 'POST', body) })); })} />
      </> : null}
      {shared ? <>
        <Button label="Open approved history handoff" variant="secondary" disabled={busy} onPress={() => void run(() => loadIncoming(shared.shareId))} />
        <Button label="Copy handoff link" variant="secondary" disabled={busy} onPress={() => void run(async () => { await scoped(active, () => Clipboard.setStringAsync(`https://thepackproof.com${shared.path}`)); })} />
        <Button label="Choose where to share this handoff" variant="secondary" disabled={busy} onPress={() => void run(async () => { await scoped(active, () => Share.share({ message: `https://thepackproof.com${shared.path}` })); })} />
        <Button label="Revoke handoff" variant="destructive" disabled={busy} onPress={() => void run(async () => { await request(`/history/shares/${encodeURIComponent(shared.shareId)}/revoke`, 'POST', {}); setShared(null); setIncoming(null); })} />
        <Text style={{ ...text, fontSize: 12 }}>Only the selected authorized account and the creator can open this handoff.</Text>
      </> : null}
    </InfoCard>
    <InfoCard>
      <Text accessibilityRole="header" style={{ color: colors.textPrimary, fontSize: 18, fontWeight: '700' }}>Open shared history</Text>
      <FormField label="History handoff link or identifier" value={incomingInput} editable={!busy} onChangeText={value => { setIncoming(null); setIncomingInput(value.slice(0, 2000)); }} />
      <Button label="Open this history selection" variant="secondary" disabled={busy || !incomingInput.trim()} onPress={() => void run(() => loadIncoming(incomingInput))} />
      {incoming ? <>{incoming.changedSinceApproval ? <Text style={{ ...text, color: colors.warningText }}>Permissions, consent, or observations changed after approval. Unavailable entries remain withheld.</Text> : null}<HistoryContents entries={incoming.preview.entries} limitations={incoming.preview.limitations} /></> : null}
    </InfoCard>
    {(data.limitations ?? []).map((limit, index) => <Text key={index} style={{ ...text, fontSize: 12 }}>{limit}</Text>)}
  </View>;
}
