import type { ProofCollectionItem, ProofView } from '../v2-api';
import { presentationForProof } from '../copy/proof-list';
import { proofDisplayTitle } from '../copy/proof-title';
import { humanChronologyTitle } from '../copy/chronology';
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
  const row: ProofCollectionItem & { workflowHint?: string } = {
    proofId: proof.proofId, transactionId: proof.transactionId, role,
    status: proof.status, workflowType: proof.workflowType, createdAt: proof.createdAt,
    updatedAt: proof.updatedAt, finalizedAt: proof.finalizedAt, presentation, workflowHint: proof.nextAction?.hint,
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
  const audit = proof.events?.find(row => row.eventId === event.id);
  const actor = audit?.actorUserId;
  if (!actor) return null;
  if (actor === userId) return 'You';
  // Only use the event's role when it explicitly describes this actor. An
  // invitation's role describes its recipient, not necessarily its author.
  const role = audit?.data?.userId === actor && audit.eventType === 'PARTICIPANT_JOINED'
    ? audit.data.role : proof.participants.find(person => person.userId === actor && person.status === 'JOINED')?.role;
  return role === 'SELLER' ? 'Seller' : role === 'BUYER' ? 'Buyer' : null;
}

/** Roles in event titles come from that event, never from the current viewer. */
export function proofHistoryTitle(proof: Pick<ProofView, 'events'> | undefined, event: { id: string; eventType: string; title: string }): string {
  const audit = proof?.events?.find(row => row.eventId === event.id && row.eventType === event.eventType);
  if (event.eventType === 'PARTICIPANT_JOINED') {
    if (audit?.data.role === 'SELLER') return 'Seller joined';
    if (audit?.data.role === 'BUYER') return 'Buyer joined';
  }
  return humanChronologyTitle(event.eventType, event.title);
}

/** Match this exact displayed number; an imported transaction is not field provenance. */
export function proofTrackingSource(proof: Pick<ProofView, 'captureShipping'>, trackingNumber: string | null | undefined): string | null {
  if (!trackingNumber) return null;
  const observed = proof.captureShipping?.observations.some(row => row.trackingNumber === trackingNumber);
  return observed ? 'Reported during recording · not independently verified' : 'Saved shipping details · number source not recorded';
}
