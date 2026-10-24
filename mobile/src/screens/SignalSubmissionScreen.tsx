import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import type { ProofView } from '../v2-api';
import { sameCaptureAccount } from '../capture/recovery-model';
import { AppScreen } from '../ui/AppScreen';
import { AppHeader } from '../ui/AppHeader';
import { Button } from '../ui/Button';
import { SignalText, SignalSteps, SignalProgress, SignalReceipt, SignalBadge } from '../ui/Signal';
import { hasSignalReceipt, signalDuration } from '../experience/signal/receipt';
import { originalAvailabilityCopy, operationTransportPercent, submissionPresentation } from '../experience/signal/submission-presentation';

export function SignalSubmissionScreen() {
  const app = usePackProof(), identity = app.route.signalSubmission;
  const current = Boolean(identity && app.session?.userId === identity.userId &&
    app.client.apiBaseUrl.replace(/\/+$/, '') === identity.apiBaseUrl.replace(/\/+$/, ''));
  const capture = current && identity ? app.savedRecordings.find(row =>
    row.uri === identity.uri && row.captureUserId === identity.userId && row.captureProofId === identity.proofId &&
    row.recovery?.proofId === identity.proofId && row.recovery.operationId === identity.operationId &&
    sameCaptureAccount(row.recovery, identity.apiBaseUrl, identity.userId)) : undefined;
  const [confirmed, setConfirmed] = useState<{ key: string; proof: ProofView } | null>(null);
  const [checkingError, setCheckingError] = useState<string | null>(null);
  const key = identity ? JSON.stringify(identity) : '';
  const confirmationKey = JSON.stringify([key, capture?.uploadEvidenceId]);
  useEffect(() => { setConfirmed(null); }, [confirmationKey, current, app.client]);

  useEffect(() => {
    let alive = true, running = false, done = false;
    setCheckingError(null);
    async function refresh() {
      if (!current || !identity || !capture?.uploadEvidenceId || running || done) return;
      running = true;
      try {
        const [proof, recovery] = await Promise.all([
          app.client.getProof(identity.proofId), app.client.getProofRecovery(identity.proofId),
        ]);
        if (alive) {
          app.client.assertCaptureAccount(identity.userId, identity.apiBaseUrl);
          if (hasSignalReceipt(proof, recovery, { proofId: identity.proofId, evidenceId: capture.uploadEvidenceId })) {
            setConfirmed({ key: confirmationKey, proof }); done = true;
          }
          setCheckingError(null);
        }
      } catch {
        if (alive) setCheckingError(`The server confirmation is unavailable. ${originalAvailabilityCopy(capture.localFileAvailable)}`);
      } finally { running = false; }
    }
    void refresh();
    const interval = setInterval(() => void refresh(), 5000);
    return () => { alive = false; clearInterval(interval); };
  }, [confirmationKey, current, app.client, capture?.recovery?.phase, capture?.localFileAvailable]);

  if (!identity || !current) return <AppScreen>
    <AppHeader title="Saved recording" onBack={() => app.go('home')} />
    <SignalText muted>Sign in to the original account to continue this recording.</SignalText>
    <Button label="Back to Home" onPress={() => app.go('home')} />
  </AppScreen>;
  const proof = confirmed?.key === confirmationKey ? confirmed.proof : null;
  const title = app.proofCollection.find(row => row.proofId === identity.proofId)?.transaction.itemTitle || 'Packing record';
  const openProof = () => void app.run(async () => {
    app.client.assertCaptureAccount(identity.userId, identity.apiBaseUrl);
    await app.openProof(identity.proofId);
  });
  if (!capture && !proof) return <AppScreen>
    <AppHeader title="Saved recording" onBack={() => app.go('home')} />
    <SignalBadge state="attention">Local operation unavailable</SignalBadge>
    <SignalText kind="title">Check the saved Proof.</SignalText>
    <SignalText muted>This operation is not in this device's saved recordings. Open the exact Proof to check its server-confirmed evidence, or return to the recording device.</SignalText>
    <Button label="Check this Proof" disabled={app.busy || app.offline} onPress={openProof} />
    <Button label="Back to Home" variant="secondary" onPress={() => app.go('home')} />
  </AppScreen>;
  const phase = capture?.recovery?.phase;
  const percent = operationTransportPercent({ identity, captures: app.savedRecordings,
    percent: Object.prototype.hasOwnProperty.call(app.uploadProgressByProof, identity.proofId) ? app.uploadProgressByProof[identity.proofId] : null });
  const presentation = submissionPresentation({ phase, offline: app.offline, originalAvailable: capture?.localFileAvailable, percent });
  const resume = () => { if (capture) void app.resumeSavedCapture(capture); };
  const recovery = () => void app.run(async () => {
    app.client.assertCaptureAccount(identity.userId, identity.apiBaseUrl);
    if (capture) app.go('activity', { activityFilter: 'all', activitySessionId: capture.captureSessionId || capture.uri });
  });
  return <AppScreen>
    <AppHeader title={title} onBack={() => app.go('home')} />
    {proof ? <SignalReceipt operationKey={confirmationKey} title={proof.transaction.itemTitle || title}
      proofId={proof.proofId} savedAt={proof.finalizedAt!} duration={signalDuration(capture?.durationMs)}
      onHome={() => app.go('home')} onView={openProof} /> : <>
      <SignalSteps step={3} />
      <SignalProgress presentation={presentation} />
      <View style={{ gap: 16, marginTop: 24 }}>
        {phase === 'SUBMITTED' ? <SignalText kind="small" muted>The saved operation reports submission complete. Canonical receipt confirmation is still being checked.</SignalText> : null}
        {checkingError ? <SignalText kind="small" muted>{checkingError}</SignalText> : null}
        {capture?.recovery?.lastError ? <SignalText kind="small" muted>{capture.recovery.lastError.message}</SignalText> : null}
        {capture && presentation.action !== 'none' ? <Button
          label={presentation.action === 'review' ? 'Review and confirm' : presentation.action === 'sign-in' ? 'Sign in to continue' : presentation.action === 'recovery' ? 'Review saved work' : 'Resume saving'}
          disabled={app.busy || app.offline} onPress={presentation.action === 'recovery' ? recovery : resume} /> : null}
        <Button label="Continue to Home" variant="secondary" onPress={() => app.go('home')} />
      </View>
    </>}
  </AppScreen>;
}
