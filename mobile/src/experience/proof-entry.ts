import { selectRecoveryWorkspace, type RecoveryWorkspaceInput } from './recovery-workspace';

/** An entry intent selects an existing owner; it never grants capture authority. */
export type ProofEntry =
  | { proofId: string; intent: 'resume' | 'view' }
  | { proofId: string; intent: 'historyShare'; historyShareId: string };

export interface ProofEntryOwners {
  /** Reconciles invitations, local originals and fresh server permission. */
  resume: (proofId: string) => Promise<boolean>;
  /** Authorized evidence viewer; cached records may be read offline. */
  view: (proofId: string) => Promise<void>;
  assertCurrentAccount: () => void;
  historyShare: (historyShareId: string) => void;
}

/** History shares remain intentional viewers, including for unfinished Proofs. */
export function participantLinkEntry(proofId: string, historyShareId: string | null | undefined, taskFirst: boolean): ProofEntry {
  if (historyShareId) return { proofId, intent: 'historyShare', historyShareId };
  return { proofId, intent: taskFirst ? 'resume' : 'view' };
}

/** Use the same exact original chosen by Home, never the first unscoped array row. */
export function proofEntryRecording(input: RecoveryWorkspaceInput, proofId: string) {
  const workspace = selectRecoveryWorkspace(input);
  const action = workspace.model.actions.find(row => row.targetId === proofId) ?? null;
  const pending = workspace.captures.filter(capture => capture.captureProofId === proofId && !['FINALIZED', 'SUBMITTED'].includes(capture.recovery?.phase ?? ''));
  const capture = action?.sessionId
    ? pending.find(row => (row.captureSessionId || row.uri) === action.sessionId) ?? null
    : pending[0] ?? null;
  // Selection remains guidance: the existing resume owner checks fresh authority.
  return { capture, action };
}

/** Observe an existing handled-error owner without changing its error policy. */
export async function handledActionSucceeded(run: (action: () => Promise<void>) => Promise<void>, action: () => Promise<void | boolean>): Promise<boolean> {
  let succeeded = false;
  await run(async () => { succeeded = await action() !== false; });
  return succeeded;
}

export async function openProofDestination(entry: ProofEntry, owners: ProofEntryOwners): Promise<boolean> {
  owners.assertCurrentAccount();
  let opened = true;
  if (entry.intent === 'resume') opened = await owners.resume(entry.proofId);
  else await owners.view(entry.proofId);
  // A session may change while a fresh record is being fetched. In particular,
  // a history-share locator must never be applied to another account's record.
  owners.assertCurrentAccount();
  if (entry.intent === 'historyShare') owners.historyShare(entry.historyShareId);
  return opened;
}
