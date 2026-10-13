import type { LocalCapture } from '../capture';
import type { PhotoDraft } from '../capture/photo-draft-model';
import { photoDraftRemaining } from '../capture/photo-draft-model';
import { activityGroup } from './activity-model';
import { nativeHomeInput } from './home-adapter';
import { selectTaskHome, type HomeAction } from './task-home';
import { workspaceProofRows } from '../copy/workspace-summary';
import type { LocalCaptureStatus } from '../copy/status';

export type RecoveryWorkspaceInput = Parameters<typeof nativeHomeInput>[0] & {
  photoDrafts?: PhotoDraft[]; localCapture?: LocalCapture | null; captureStatus?: LocalCaptureStatus;
};
/** One display policy across Home, Proofs and Updates. Cached classifications never authorize a command. */
export function selectRecoveryWorkspace(input: RecoveryWorkspaceInput) {
  const api = input.apiBaseUrl.replace(/\/+$/, '');
  const captures = input.captures.filter(row => row.captureUserId === input.userId && row.recovery?.apiBaseUrl.replace(/\/+$/, '') === api);
  const base = nativeHomeInput({ ...input, captures });
  const model = selectTaskHome(base);
  const classified = selectTaskHome({ ...base, online: true, reconciled: true });
  if (!input.online && !model.actions.length && classified.actions.length) {
    const cached = classified.actions[0];
    model.recommendation = { ...cached, kind: 'continue_proof', buttonLabel: 'View saved Proof',
      reason: 'Cached record. Reconnect before submitting or starting a new recording.', sourceFreshness: 'cached' };
  }
  const photoDrafts = (input.photoDrafts ?? []).filter(row => row.userId === input.userId && row.apiBaseUrl === api && row.phase !== 'COMPLETE');
  for (const draft of photoDrafts) {
    const proof = base.proofs.find(row => row.id === draft.proofId && row.authorized);
    if (!proof || proof.completed && draft.phase === 'LOCAL_ONLY') continue;
    const remaining = photoDraftRemaining(draft);
    const action: HomeAction = { kind: 'continue_proof', targetId: draft.proofId, rank: 0, count: 1, sourceFreshness: 'device',
      title: proof.title, buttonLabel: 'Resume photos', reason: draft.phase === 'SUBMITTING' ? 'Saved photo submission needs to be checked.' :
        remaining ? `${draft.slots.length} saved on device · ${remaining} ${remaining === 1 ? 'photo' : 'photos'} remaining` : 'Photos saved on device · ready to review' };
    for (const target of [model, classified]) {
      target.actions = target.actions.filter(row => row.targetId !== draft.proofId);
      target.actions.unshift(action);
    }
  }
  if (model.actions.some(row => row.rank === 0)) model.recommendation = model.actions.find(row => row.rank === 0)!;
  const actions = new Map(classified.actions.map(action => [action.targetId, action]));
  const rows = workspaceProofRows({ proofs: input.proofs, invitations: input.invitations, recordings: captures,
    localCapture: null, captureStatus: input.captureStatus ?? 'idle', uploadProgressByProof: input.progress }).map(row => {
    const action = actions.get(row.proofId);
    const capture = captures.find(c => c.captureProofId === row.proofId && !['FINALIZED', 'SUBMITTED'].includes(c.recovery?.phase ?? ''));
    return { ...row, presentation: { ...row.presentation, needsAttention: Boolean(action),
      displayStatus: action?.kind === 'reconcile' ? 'Status needs refresh' : row.presentation.displayStatus,
      nextAction: action ? { ...row.presentation.nextAction, label: action.buttonLabel } : row.presentation.nextAction },
      taskDescription: action?.reason ?? (capture ? 'Upload pending · original retained on device' : row.presentation.displayStatus),
      action };
  });
  // Both the displayed number and its destination use the same set, including cached pending actions.
  model.counts.attention = rows.filter(row => row.presentation.needsAttention).length;
  model.counts.uploading = captures.filter(capture => activityGroup(capture) === 'uploading' && capture.recovery?.phase !== 'SUBMITTED').length + photoDrafts.filter(draft => draft.phase === 'SUBMITTING').length;
  model.empty = model.empty && !photoDrafts.length;
  return { model, rows, captures, photoDrafts, attention: rows.filter(row => row.presentation.needsAttention) };
}
