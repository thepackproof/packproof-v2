import { useSignalReceipt } from '../experience/signal/use-receipt';
import { workspaceRecordings } from '../copy/workspace-summary';
import { mayCleanUpCapture } from '../capture/recovery-model';
import { requiresRecordingRecovery } from '../capture/recording-review';
import { operationTransportPercent, submissionPresentation } from '../experience/signal/submission-presentation';
import { StyleSheet, View } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import { useTaskHome } from '../experience/use-task-home';
import { useTheme } from '../theme/ThemeProvider';
import { AppScreen } from '../ui/AppScreen';
import { WorkspaceHeader } from '../ui/WorkspaceHeader';
import { Button } from '../ui/Button';
import { ErrorBanner } from '../ui/EmptyState';
import { SignalText, SignalRow, SignalBadge, SignalSources } from '../ui/Signal';
import { PresentationalReveal } from '../ui/motion';

export function SignalHomeScreen() {
  const app = usePackProof(), home = useTaskHome(), { colors } = useTheme();
  const next = home.recommendation;
  const retained = workspaceRecordings(app.savedRecordings, app.localCapture).filter(row =>
    row.captureUserId === app.session?.userId && row.recovery?.apiBaseUrl.replace(/\/+$/, '') === app.apiBaseUrl.replace(/\/+$/, ''));
  const unfinished = retained.filter(row => !['FINALIZED', 'SUBMITTED'].includes(row.recovery?.phase || ''));
  const pending = next.targetId ? unfinished.find(row => row.captureProofId === next.targetId && (!next.sessionId || (row.captureSessionId || row.uri) === next.sessionId || row.recovery?.operationId === next.sessionId)) : unfinished[0];
  const selected = app.proofCollection.find(row => row.proofId === next.targetId);
  const recentSaved = home.recent.find(row => row.presentation.completed);
  const featured = selected || app.proofCollection.find(row => row.proofId === pending?.captureProofId) || recentSaved;
  const uploading = Boolean(pending?.recovery?.submitRequested);
  const paused = uploading && (app.offline || ['NEEDS_ATTENTION', 'NEEDS_SIGN_IN', 'CONFIRMATION_NEEDED', 'DISCARD_PENDING'].includes(pending?.recovery?.phase || ''));
  const needsRecovery = Boolean(pending && (pending.localFileAvailable === false || requiresRecordingRecovery(pending)));
  const confirmed = useSignalReceipt(recentSaved?.proofId || '', recentSaved?.updatedAt || '', Boolean(recentSaved));
  const saved = confirmed || Boolean(recentSaved && retained.some(row => row.captureProofId === recentSaved.proofId && row.recovery && mayCleanUpCapture(row.recovery)));
  const mode = paused ? 'paused' : uploading ? 'uploading' : pending ? 'local' : next.kind !== 'create_proof' ? 'task' : recentSaved ? 'saved' : 'ready';
  const percent = pending?.recovery ? operationTransportPercent({ identity: pending.recovery, captures: retained,
    percent: Object.prototype.hasOwnProperty.call(app.uploadProgressByProof, pending.recovery.proofId) ? app.uploadProgressByProof[pending.recovery.proofId] : null }) : null;
  const pendingPresentation = pending ? submissionPresentation({ phase: pending.recovery?.phase, offline: app.offline,
    originalAvailable: pending.localFileAvailable, percent }) : null;
  function openProgress() {
    if (pending?.recovery) app.go('submission', { signalSubmission: {
      userId: pending.recovery.userId, apiBaseUrl: pending.recovery.apiBaseUrl,
      proofId: pending.recovery.proofId, operationId: pending.recovery.operationId, uri: pending.uri,
    } });
  }
  const actionLabel = next.kind === 'create_proof' ? 'Pack an item' : next.buttonLabel;
  const runAction = () => { void home.runAction(next); };
  const heading = needsRecovery ? 'A recording needs attention.' : mode === 'paused' ? 'Pick up where you left off.' : mode === 'uploading' ? 'Your work keeps moving.'
    : mode === 'local' ? 'Your take is ready to review.' : mode === 'saved' ? 'Ready for the next one?' : mode === 'task' ? 'One clear next step.' : 'Your evidence, connected.';
  const explanation = needsRecovery ? 'Inspect any surviving recording in this exact recovery task before starting another take.'
    : (mode === 'paused' || mode === 'uploading' || mode === 'local') && pendingPresentation ? pendingPresentation.detail
    : mode === 'saved' ? 'Your records stay together. Start your next packing Proof when you are ready.'
    : mode === 'task' ? next.reason : 'Record the packing process. Keep the original evidence and its context together in one Proof.';
  return <AppScreen bottomInset={false} restorationReady={!home.loading} onRefresh={() => void home.refresh()} refreshing={home.refreshing}
    initialOffsetY={app.readWorkspaceOffset('home')} onScrollOffset={offset => app.setWorkspaceOffset('home', offset)}>
    <WorkspaceHeader section="Home" />
    <View style={styles.intro}>
      <SignalText kind="caption" muted>YOUR EVIDENCE WORKSPACE</SignalText>
      <SignalText kind="title">{heading}</SignalText>
    </View>
    <PresentationalReveal duration={520} onceKey={`${app.apiBaseUrl}:${app.session?.userId}:home`}>
      <View style={styles.feature}>
        <View accessible={false} style={styles.featureAccent} />
        <SignalText kind="caption" style={styles.onNavyMuted}>{home.loading ? 'LOADING YOUR WORKSPACE' : mode === 'paused' ? 'ACTION NEEDED'
          : mode === 'uploading' ? 'SAVING IN PROGRESS' : mode === 'local' ? pending?.localFileAvailable===true&&!needsRecovery?'SAVED ON THIS DEVICE':'LOCAL RECORDING STATUS' : 'ONE PROOF. CONNECTED CONTEXT.'}</SignalText>
        <SignalText kind="subheading" style={styles.onNavy}>{featured?.transaction.itemTitle || (next.kind === 'create_proof' ? 'Your next Proof starts here.' : next.title)}</SignalText>
        <SignalText kind="small" style={styles.onNavyMuted}>{featured?.transaction.externalReference || explanation}</SignalText>
        {featured ? <SignalSources inverted order={Boolean(featured.transaction.externalReference || featured.transaction.provider || featured.transaction.source)}
          evidence={Boolean(featured.thumbnailDerivativeId || pending?.captureProofId === featured.proofId || featured.finalizedAt)}
          shipment={Boolean(featured.transaction.carrier || featured.transaction.trackingNumber)} /> : null}
      </View>
    </PresentationalReveal>
    <View onTouchStart={()=>home.setInteracting(true)} onTouchEnd={()=>home.setInteracting(false)} onTouchCancel={()=>home.setInteracting(false)}><Button label={actionLabel} icon="arrow-forward" loading={app.busy} disabled={home.loading || (next.kind === 'create_proof' && app.offline)} onPress={runAction} /></View>
    {mode !== 'ready' ? <SignalText kind="small" muted>{explanation}</SignalText> : null}
    {mode === 'uploading' ? <SignalBadge state="uploading">{pendingPresentation?.stageLabel || 'Saved operation pending'}</SignalBadge>
      : mode === 'paused' ? <SignalBadge state="attention">Action needed</SignalBadge>
      : mode === 'local' ? <SignalBadge state={pending?.localFileAvailable===false?"attention":"local"}>{pending?.localFileAvailable===false?"Original unavailable on this device":"Local recording. Not yet confirmed."}</SignalBadge>
      : mode === 'saved' && featured ? <SignalBadge state={saved ? 'saved' : 'local'}>{saved ? 'Saved to PackProof' : 'Proof finalized'}</SignalBadge> : null}
    {mode === 'uploading' ? <Button label="View saving progress" variant="secondary" disabled={app.busy} onPress={openProgress} /> : null}
    <View style={[styles.records, { borderColor: colors.border }]}>
      <SignalText kind="heading">{next.kind === 'create_proof' ? 'Recent Proofs' : 'Your records'}</SignalText>
      {selected ? <SignalRow proof={selected} detail={next.reason} disabled={app.busy} onPress={() => void home.runAction(next)} />
        : !home.loading && next.kind !== 'create_proof' ? <Button label={next.buttonLabel} variant="secondary" onPress={() => void home.runAction(next)} /> : null}
      {home.recent.filter(row => row.proofId !== next.targetId).slice(0, 3).map(row =>
        <SignalRow key={row.proofId} proof={row} disabled={app.busy} onPress={() => void home.openProof(row)} />)}
      {!home.recent.length && !selected ? <View style={[styles.empty, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <SignalText kind="strong">{home.loading ? 'Loading your records' : 'A clear record starts with a take.'}</SignalText>
        <SignalText kind="small" muted>{home.loading ? 'Checking this workspace.' : 'Your packing records appear here after you start a Proof.'}</SignalText>
      </View> : null}
      <Button label="View all Proofs" variant="tertiary" onPress={() => { app.setProofsView('all'); app.go('proofs'); }} />
    </View>
    {app.offline ? <SignalText kind="small" muted>You're offline. Open saved work to check local recordings. Reconnect to continue server operations.</SignalText> : null}
    {(!app.workspaceReconciled || app.offline) ? <SignalText kind="caption" muted>{home.freshnessLabel}</SignalText> : null}
    <ErrorBanner message={home.error} />
    {home.error ? <Button label="Refresh records" variant="tertiary" onPress={() => void home.refresh()} /> : null}
  </AppScreen>;
}

const styles = StyleSheet.create({
  intro: { gap: 8, paddingTop: 12 },
  feature: { backgroundColor: '#0A172A', borderRadius: 16, padding: 24, gap: 14, minHeight: 176, overflow: 'hidden' },
  featureAccent: { position: 'absolute', top: 0, right: 0, width: 100, height: 3, backgroundColor: '#3478FF' },
  onNavy: { color: '#FFFFFF' }, onNavyMuted: { color: '#A5B6CB' },
  records: { marginTop: 8, borderTopWidth: 1, paddingTop: 24, gap: 12 },
  empty: { padding: 20, borderRadius: 16, borderWidth: 1, gap: 8 },
});
