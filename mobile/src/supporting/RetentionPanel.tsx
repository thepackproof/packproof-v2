import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Text, View } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { FormField } from '../ui/FormField';
import { InfoCard } from '../ui/ProofCard';
import { ErrorBanner } from '../ui/EmptyState';
import { preservationReason, readRetention, releasableHold, type RetentionState } from './retention';

/** The parent keys this component by API, account and Proof. */
export function RetentionPanel({ proofId, userId }: { proofId: string; userId: string }) {
  const app = usePackProof(), { colors } = useTheme();
  const [state, setState] = useState<RetentionState | null>(null), [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const lifetime = useRef(0), mounted = useRef(false), locked = useRef(false), refreshOnResume = useRef(false);
  const apiBaseUrl = app.apiBaseUrl, client = app.client;
  const identity = `${apiBaseUrl}:${userId}:${proofId}`, identityRef = useRef(identity); identityRef.current = identity;
  const stateRef = useRef(state); stateRef.current = state;
  const body = [typography.body, { color: colors.textPrimary }], secondary = [typography.secondary, { color: colors.textSecondary }];
  function current(epoch: number) { return mounted.current && identityRef.current === identity && lifetime.current === epoch && AppState.currentState === 'active'; }
  function assert(epoch: number) {
    if (!current(epoch)) throw new Error('This preservation request is no longer active. Reopen the Proof to continue.');
    client.assertCaptureAccount(userId, apiBaseUrl);
  }
  async function run(action?: { path: string; method: 'POST' | 'DELETE'; reason?: string; holdId?: string }, expectedEpoch = lifetime.current) {
    if (locked.current || !current(expectedEpoch)) return;
    const epoch = expectedEpoch; locked.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await app.ensureAuth(); assert(epoch);
      if (action) {
        if (action.holdId && !releasableHold(stateRef.current, action.holdId, userId)) throw new Error('Only your own active hold can be released. Refresh the current state.');
        await client.retentionRequest(proofId, action.path, action.method, action.reason === undefined ? undefined : { reason: preservationReason(action.reason) }); assert(epoch);
        setNotice('Request recorded. Loading the current preservation status…');
      }
      const result = readRetention(await client.retentionRequest<unknown>(proofId)); assert(epoch);
      setState(result);
      if (action) { setReason(''); setNotice(action.path === '/deletion-requests' ? 'Deletion review requested. The record remains preserved.' : action.method === 'DELETE' ? 'Your hold was released. Other preservation requirements still apply.' : 'Preservation hold recorded.'); }
    } catch (failure) { if (current(epoch)) setError(failure instanceof Error ? failure.message : 'Preservation details could not be updated. Refresh before trying again.'); }
    finally {
      locked.current = false;
      if (mounted.current && identityRef.current === identity) {
        setBusy(false);
        if (refreshOnResume.current && AppState.currentState === 'active') { refreshOnResume.current = false; void run(); }
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (locked.current) refreshOnResume.current = true; else void run();
    const subscription = AppState.addEventListener('change', state => {
      lifetime.current += 1;
      if (state === 'active') { if (locked.current) refreshOnResume.current = true; else void run(); }
    });
    return () => { mounted.current = false; lifetime.current += 1; subscription.remove(); };
  }, [identity]);
  function confirmRelease(id: string) {
    const epoch = lifetime.current;
    Alert.alert('Release your preservation hold?', 'Other holds and retention requirements still protect this Proof. Releasing your hold does not delete evidence.', [
      { text: 'Keep hold', style: 'cancel' },
      { text: 'Release my hold', onPress: () => void run({ path: `/holds/${encodeURIComponent(id)}`, method: 'DELETE', holdId: id }, epoch) },
    ]);
  }
  function requestDeletion() {
    const epoch = lifetime.current, submittedReason = reason;
    Alert.alert('Request deletion review?', 'This submits your reason for review. Evidence is not deleted immediately, and preservation requirements still apply.', [
      { text: 'Keep record', style: 'cancel' },
      { text: 'Request review', onPress: () => void run({ path: '/deletion-requests', method: 'POST', reason: submittedReason }, epoch) },
    ]);
  }
  return <View style={{ gap: 16 }}>
    <Text style={secondary}>Evidence is retained for at least 90 days after the latest finalized stage. Active holds and unfinished receipt or return stages prevent evidence deletion. Requests are reviewed and do not remove evidence immediately.</Text>
    <ErrorBanner message={error} />
    {notice ? <Text accessibilityRole="alert" style={secondary}>{notice}</Text> : null}
    {state ? <>
      <Text style={body}>{state.protectedUntil ? `Protected through ${new Date(state.protectedUntil).toLocaleDateString()}` : 'This Proof is active.'}</Text>
      {state.blockers.length ? <InfoCard><Text style={[typography.bodyStrong, { color: colors.textPrimary }]}>Current preservation requirements</Text>{state.blockers.map((blocker, index) => <Text key={index} style={secondary}>{blocker}</Text>)}</InfoCard> : null}
      {state.holds.filter(hold => !hold.releasedAt).map(hold => <InfoCard key={hold.id}>
        <Text style={body}>{hold.reason}</Text>
        <Text style={secondary}>{hold.createdBy === userId ? 'Your active hold' : 'Another participant’s active hold'}</Text>
        {hold.createdBy === userId ? <Button label="Release my hold" variant="secondary" disabled={busy} onPress={() => confirmRelease(hold.id)} /> : null}
      </InfoCard>)}
      {state.deletionRequests.map(request => <Text key={request.id} style={secondary}>Deletion review: {request.state.replaceAll('_', ' ').toLowerCase()}</Text>)}
    </> : null}
    <FormField label="Reason for preservation or deletion review" value={reason} onChangeText={value => setReason(value.slice(0, 1000))} multiline editable={!busy} />
    <Button label="Place preservation hold" variant="secondary" disabled={busy || !reason.trim() || !state} onPress={() => void run({ path: '/holds', method: 'POST', reason })} />
    <Button label="Request deletion review" variant="secondary" disabled={busy || !reason.trim() || !state} onPress={requestDeletion} />
    <Button label="Refresh preservation status" variant="tertiary" loading={busy} onPress={() => void run()} />
  </View>;
}
