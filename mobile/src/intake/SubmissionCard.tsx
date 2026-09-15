import { SubmissionDetails } from './SubmissionDetails';
import { ResolveOrder } from './ResolveOrder';
import { intakeItemLabel, type IntakeOrder } from './model';
import { useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { IntakeApi } from './api';
import type { IntakeSubmission } from './submissions';

/** All candidate IDs and capture eligibility are reauthorized by the API. */
export function SubmissionCard({ submission, disabled = false, onChange, onLeave }: {
  submission: IntakeSubmission; disabled?: boolean; onChange: (value: IntakeSubmission) => void; onLeave?: () => void | Promise<void>;
}) {
  const app = usePackProof(), { colors } = useTheme();
  const [manual, setManual] = useState(false);
  const [prepared, setPrepared] = useState<IntakeOrder | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const lock = useRef(false), owner = app.session?.userId;
  const alive = useRef(owner); alive.current = owner;
  const api = new IntakeApi(app.client);
  useEffect(() => {
    if (!submission.transactionId || !owner) return;
    let active = true;
    void app.ensureAuth().then(() => { app.client.assertCaptureAccount(owner, app.apiBaseUrl); return api.prepare(submission.transactionId!); }).then(order => {
      if (active && alive.current === owner && order.proofId === submission.proofId) setPrepared(order);
    }).catch(() => { if (active) setError('The matched order could not be loaded. Reconnect and check again before recording.'); });
    return () => { active = false; };
  }, [submission.transactionId, submission.updatedAt, owner]);
  async function action(operation: () => Promise<void>) {
    if (lock.current || disabled || !owner) return;
    lock.current = true; setBusy(true); setError(null);
    try { await app.ensureAuth(); app.client.assertCaptureAccount(owner, app.apiBaseUrl); await operation(); }
    catch (reason) { if (alive.current === owner) setError(reason instanceof Error ? reason.message : 'Could not update this order. Try again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function record() {
    const fresh = await api.submission(submission.submissionId);
    app.client.assertCaptureAccount(owner!, app.apiBaseUrl); onChange(fresh);
    if (fresh.nextAction !== 'RECORD_PACKING' || !fresh.transactionId || !fresh.proofId) return;
    const order = await api.prepare(fresh.transactionId);
    app.client.assertCaptureAccount(owner!, app.apiBaseUrl);
    if (order.readiness !== 'READY' || !order.snapshot || order.proofId !== fresh.proofId) throw new Error('This order changed. Refresh it before recording.');
    // Only this explicit button enters the existing camera workflow.
    await onLeave?.(); await app.startIntakeCapture({ snapshotId: order.snapshot.id });
  }
  if (submission.state === 'DISMISSED') return null;
  return <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    <Text style={[styles.title, { color: colors.textPrimary }]}>{submission.state === 'READY' ? 'Order ready' : submission.state === 'NEEDS_SELECTION' ? 'Choose the order' : submission.state === 'NEEDS_CONNECTION' ? 'Connect your store' : 'Shared order'}</Text>
    {prepared?.snapshot ? <View style={styles.candidate}><Text style={[styles.title, { color: colors.textPrimary }]}>{prepared.snapshot.store} · Order {prepared.snapshot.orderReference}</Text>{prepared.snapshot.items.map((item, index) => <Text key={index} style={[styles.copy, { color: colors.textPrimary }]}>{intakeItemLabel(item)}</Text>)}</View> : null}
    <Text style={[styles.copy, { color: colors.textSecondary }]}>{submission.message || 'Added to PackProof. We are checking the order.'}</Text>
    {submission.state === 'READY' && submission.nextAction === 'RECORD_PACKING' ? <Button label="Record packing" icon="videocam-outline" loading={busy} disabled={disabled || !prepared?.snapshot} onPress={() => void action(record)} /> : null}
    {submission.nextAction === 'OPEN_PROOF' && submission.proofId ? <Button label="Open Proof" loading={busy} disabled={disabled} onPress={() => void action(async () => { await onLeave?.(); await app.openProof(submission.proofId!); })} /> : null}
    {submission.candidates.map(candidate => <View key={candidate.candidateId} style={styles.candidate}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{candidate.orderReference} · {candidate.provider}</Text>
      <Text style={[styles.copy, { color: colors.textSecondary }]}>{candidate.itemSummary}</Text>
      <Button label={`Choose order ${candidate.orderReference}`} variant="secondary" disabled={disabled || busy} onPress={() => void action(async () => { const resolved = await api.resolveSubmission(submission.submissionId, { candidateId: candidate.candidateId }); app.client.assertCaptureAccount(owner!, app.apiBaseUrl); onChange(resolved); })} />
    </View>)}
    {submission.nextAction === 'CONNECT_ACCOUNT' ? <Button label="Open Connections" disabled={disabled || busy} onPress={() => { void Promise.resolve(onLeave?.()).then(() => app.go('account', { accountSection: 'channels' })); }} /> : null}
    {['REVIEW_DETAILS', 'CONNECT_ACCOUNT', 'SELECT_ORDER'].includes(submission.nextAction) && !submission.transactionId && !manual ? <Button label="Enter order details myself" variant="tertiary" disabled={disabled || busy} onPress={() => setManual(true)} /> : null}
    {manual && !submission.transactionId ? <SubmissionDetails submission={submission} disabled={disabled || busy} onResolved={next => { setManual(false); onChange(next); }} /> : null}
    {prepared && submission.nextAction === 'REVIEW_DETAILS' && submission.transactionId ? <ResolveOrder order={prepared} disabled={disabled || busy} onResolved={next => { setPrepared(next); void action(async () => onChange(await api.resolveSubmission(submission.submissionId, {}))); }} /> : null}
    {['RECEIVED', 'RESOLVING', 'RETRYABLE_FAILED', 'NEEDS_CONNECTION'].includes(submission.state) ? <Button label="Check again" variant="secondary" disabled={disabled} loading={busy} onPress={() => void action(async () => { const next = ['RETRYABLE_FAILED', 'NEEDS_CONNECTION'].includes(submission.state) ? await api.resolveSubmission(submission.submissionId, {}) : await api.submission(submission.submissionId); app.client.assertCaptureAccount(owner!, app.apiBaseUrl); onChange(next); })} /> : null}
    {error ? <Text accessibilityRole="alert" style={[styles.copy, { color: colors.textSecondary }]}>{error}</Text> : null}
    {submission.state !== 'READY' ? <Button label="Remove from attention" variant="tertiary" disabled={disabled || busy} onPress={() => Alert.alert('Remove this shared order?', 'This dismisses the shared input. Existing Proofs and recordings remain available.', [
      { text: 'Keep order', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => void action(async () => { onChange(await api.dismissSubmission(submission.submissionId)); await onLeave?.(); }) },
    ])} /> : null}
  </View>;
}
const styles = StyleSheet.create({ card: { padding: 16, gap: 12, borderWidth: 1, borderRadius: 8 }, candidate: { gap: 8 }, title: { ...typography.bodyStrong }, copy: { ...typography.secondary } });
