import { classifyProofPresentation, withLocalProofWork, type LocalProofWork, type ProofPresentation } from '../../../backend/src/domain/proof-presentation';
import type { ProofCollectionItem, ProofView, InvitationInboxView } from '../v2-api';
import type { LocalCapture } from '../capture';
import type { LocalCaptureStatus } from './status';
import type { ProofsLibraryState } from '../app/navigation';

export function localProofWork(capture: Pick<LocalCapture, 'interrupted' | 'recovery'> | null | undefined, captureStatus?: LocalCaptureStatus, progress?: number | null): LocalProofWork | null {
  if (!capture) return null;
  const phase = capture.recovery?.phase;
  if (phase === 'FINALIZED' || phase === 'SUBMITTED') return null;
  if (phase === 'NEEDS_ATTENTION' || phase === 'NEEDS_SIGN_IN' || captureStatus === 'retry') return { state: 'UPLOAD_INTERRUPTED' };
  if (['UPLOAD_QUEUED','UPLOADING','BYTES_RECEIVED','PRESERVATION_PENDING','FINALIZATION_PENDING'].includes(phase ?? '') || ['preparing','uploading','uploaded'].includes(captureStatus ?? '')) return { state:'UPLOADING', progress: progress ?? undefined };
  if (capture.interrupted || phase === 'RECORDING') return { state:'CAPTURE_UNFINISHED', canResumeCapture:false };
  return { state:'CONFIRMATION_NEEDED' };
}

export function presentationForProof(item: ProofCollectionItem | ProofView, role?: string | null, work?: LocalProofWork | null): ProofPresentation {
  const evidence = 'evidence' in item ? item.evidence : [];
  const base = item.presentation ?? classifyProofPresentation({
    proofId:item.proofId, status:item.status, finalizedAt:item.finalizedAt,
    role:role ?? ('role' in item ? item.role : null), workflowType:item.workflowType,
    invitationId:'invitationId' in item ? item.invitationId : null,
    fulfillmentCaptureCount:'evidence' in item ? evidence.filter(row => row.validationStatus === 'COMMITTED' && row.evidenceType === 'FULFILLMENT_CAPTURE').length : (item.status === 'EVIDENCE_COMMITTED' ? 1 : 0),
  });
  return withLocalProofWork(base, work);
}

export function mergeProofInvitations(items: ProofCollectionItem[], invitations: InvitationInboxView[]): ProofCollectionItem[] {
  const rows = new Map(items.map(item => [item.proofId, item]));
  for (const invitation of invitations) {
    if (rows.has(invitation.proofId)) continue;
    rows.set(invitation.proofId, {
      proofId:invitation.proofId, transactionId:invitation.transaction.transactionId,
      invitationId:invitation.invitationId, role:'BUYER', status:'AWAITING_PARTICIPANT',
      createdAt:invitation.createdAt, updatedAt:invitation.createdAt, finalizedAt:null,
      transaction:{ ...invitation.transaction, transactionDate:null, carrier:null, trackingNumber:null },
    });
  }
  return [...rows.values()];
}

export type PresentedProof = ProofCollectionItem & { presentation:ProofPresentation };
export function selectProofRows(rows: PresentedProof[], library: ProofsLibraryState): PresentedProof[] {
  const query = library.query.trim().toLocaleLowerCase();
  return rows.filter(row => {
    if (library.view === 'attention' && !row.presentation.needsAttention) return false;
    if (library.view === 'completed' && !row.presentation.completed) return false;
    if (library.role !== 'all' && row.role.toLowerCase() !== library.role) return false;
    if (library.carrier && row.transaction.carrier !== library.carrier) return false;
    return !query || [row.transaction.itemTitle, row.transaction.externalReference, row.transaction.trackingNumber, row.transaction.carrier, row.transaction.provider, row.role].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
  }).sort((a,b) => {
    if (library.view !== 'completed' && a.presentation.needsAttention !== b.presentation.needsAttention) return a.presentation.needsAttention ? -1 : 1;
    const at = Date.parse((library.view === 'completed' ? a.finalizedAt : a.updatedAt) || a.createdAt) || 0;
    const bt = Date.parse((library.view === 'completed' ? b.finalizedAt : b.updatedAt) || b.createdAt) || 0;
    return bt - at || a.proofId.localeCompare(b.proofId);
  });
}
