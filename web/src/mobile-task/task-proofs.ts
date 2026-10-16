import { classifyProofPresentation } from '../../../backend/src/domain/proof-presentation';
import type { HomeInput } from '../../../mobile/src/experience/task-home';
import type { ProofCollectionItem } from '../api/types';

export const taskPresentation = (proof: ProofCollectionItem) => proof.presentation ?? classifyProofPresentation(proof);
export const canContributeToTask = (proof: ProofCollectionItem | undefined) => !!proof && !proof.invitationId && proof.accessKind !== 'RECEIVER' && !!taskPresentation(proof).canContribute && !taskPresentation(proof).diagnostic;

/** Share eligibility between desktop and compact composition; collection access is not capture permission. */
export function taskProofs(input: ProofCollectionItem[]): HomeInput['proofs'] {
  return input.map(proof => {
    const view = taskPresentation(proof);
    const action: HomeInput['proofs'][number]['action'] = view.diagnostic ? 'unknown' : proof.accessKind === 'RECEIVER' || proof.invitationId ? 'continue' : !view.canContribute ? 'view' : view.nextAction.type === 'REVIEW_CONFIRM' ? 'finalize' : view.nextAction.type === 'RECORD_PACKING' ? 'capture' : view.nextAction.type === 'WORKFLOW_ACTION' ? 'continue' : 'view';
    return { id: proof.proofId, title: proof.transaction.itemTitle || 'Shipment Proof', status: proof.status, authorized: true, action, continuationAfterFinalization: !!view.canContribute && view.nextAction.type === 'WORKFLOW_ACTION', createdAt: proof.createdAt, updatedAt: proof.updatedAt, actionLabel: view.nextAction.label, actionReason: view.nextAction.type === 'RECORD_PACKING' ? 'Record the item, packing and seal in one continuous take.' : view.nextAction.label, completed: proof.status === 'FINALIZED' && !!proof.finalizedAt };
  });
}
