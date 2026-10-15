import type { ProofCollectionItem, ProofView } from '../v2-api';
import { presentationForProof } from '../copy/proof-list';
import { proofDisplayTitle } from '../copy/proof-title';
import { selectRecoveryWorkspace, type RecoveryWorkspaceInput } from './recovery-workspace';

/**
 * Detail projects its currently authorized full record into the existing workspace
 * selector. A cached catalog row never replaces its evidence, role or policy.
 * This is presentation only; every selected command still uses its existing owner.
 */
export function proofDetailModel(input: Pick<RecoveryWorkspaceInput,
  'userId' | 'apiBaseUrl' | 'captures' | 'photoDrafts' | 'progress' | 'captureStatus' | 'online' | 'reconciled'
> & { proof: ProofView }) {
  const { proof } = input;
  const role = proof.participants.find(person => person.userId === input.userId && person.status === 'JOINED')?.role ?? '';
  const presentation = presentationForProof(proof, role);
  const row: ProofCollectionItem = {
    proofId: proof.proofId, transactionId: proof.transactionId, role,
    status: proof.status, workflowType: proof.workflowType, createdAt: proof.createdAt,
    updatedAt: proof.updatedAt, finalizedAt: proof.finalizedAt, presentation,
    transaction: {
      itemTitle: proofDisplayTitle(proof), externalReference: proof.transaction.externalReference,
      transactionDate: proof.transaction.transactionDate, carrier: proof.transaction.shipping?.carrier ?? null,
      trackingNumber: proof.transaction.shipping?.trackingNumber ?? null,
    },
  };
  const workspace = selectRecoveryWorkspace({ ...input, proofs: [row], invitations: [], orders: [] });
  return {
    presentation: workspace.rows[0]?.presentation ?? presentation,
    action: workspace.model.actions.find(action => action.targetId === proof.proofId) ?? null,
    captures: workspace.captures,
    completed: presentation.completed && !presentation.diagnostic,
  };
}

/** Never infer or expose an actor from free-form history descriptions. */
export function proofHistoryActor(proof: Pick<ProofView, 'events' | 'participants'>, event: { id: string; relatedEntityId?: string | null }, userId: string): string | null {
  const actor = proof.events?.find(row => row.eventId === event.id || row.eventId === event.relatedEntityId)?.actorUserId;
  if (!actor) return null;
  if (actor === userId) return 'You';
  const role = proof.participants.find(person => person.userId === actor && person.status === 'JOINED')?.role;
  return role === 'SELLER' ? 'Seller' : role === 'BUYER' ? 'Buyer' : null;
}

/** Match this exact displayed number; an imported transaction is not field provenance. */
export function proofTrackingSource(proof: Pick<ProofView, 'captureShipping'>, trackingNumber: string | null | undefined): string | null {
  if (!trackingNumber) return null;
  const observed = proof.captureShipping?.observations.some(row => row.trackingNumber === trackingNumber);
  return observed ? 'Reported during recording · not independently verified' : 'Saved shipping details · number source not recorded';
}
