import type { SharedOrder, SharedOrderReceipt } from '../../modules/packproof-order-share';
import type { AppRouteName } from '../app/navigation';
export type SubmissionState = 'RECEIVED' | 'RESOLVING' | 'READY' | 'NEEDS_CONNECTION' | 'NEEDS_SELECTION' | 'INVALID' | 'RETRYABLE_FAILED' | 'DISMISSED';
export interface IntakeSubmission {
  submissionId: string; clientSubmissionId: string; state: SubmissionState;
  transactionId: string | null; proofId: string | null;
  nextAction: 'OPEN_PROOF' | 'RECORD_PACKING' | 'CONNECT_ACCOUNT' | 'SELECT_ORDER' | 'REVIEW_DETAILS' | 'RETRY' | 'NONE';
  retryable: boolean; errorCode: string | null; updatedAt: string; message: string;
  candidates: Array<{ candidateId: string; orderReference: string; itemSummary: string; provider: string; transactionId: string }>;
}
export interface SubmissionEnvelope {
  schemaVersion: 1; clientSubmissionId: string;
  surface: 'ANDROID_SHARE' | 'IOS_SHARE' | 'EXPLICIT_PASTE'; requestedAction: 'QUEUE';
  payload: { kind: 'TEXT' | 'URL'; text: string };
}
export function intakeEnvelope(order: SharedOrder): SubmissionEnvelope {
  if (!order.text.trim() || order.text.length > 20000 || order.errorCode) throw new Error('Share text or a link of at most 20,000 characters.');
  return { schemaVersion: 1, clientSubmissionId: order.clientSubmissionId, surface: order.surface ?? 'IOS_SHARE', requestedAction: 'QUEUE', payload: { kind: order.payloadKind, text: order.text } };
}
export function visibleLocalOrders(rows: SharedOrderReceipt[], accountId: string | null): SharedOrderReceipt[] {
  if (!accountId) return [];
  return rows.filter(row => row.accountId === null || row.accountId === accountId);
}
/** Capture/attestation/review stay in control even if a share or link arrives mid-render. */
export function canNavigateForIntake(input: { ready: boolean; accountId: string | null; route: AppRouteName; busy: boolean; captureStatus: string }): boolean {
  return input.ready && !!input.accountId && !input.busy && !['capturing', 'preparing'].includes(input.captureStatus) && ['home', 'orders', 'create', 'intake'].includes(input.route);
}
export function maySubmitLocalOrder(order: SharedOrderReceipt, accountId: string | null): boolean {
  return !!accountId && order.accountId === accountId && order.deliveryState === 'LOCAL_PENDING' && !order.errorCode;
}
export function isDurableIntakeAcknowledgment(value: unknown, clientSubmissionId: string): value is IntakeSubmission {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<IntakeSubmission>;
  return typeof row.submissionId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(row.submissionId) && row.clientSubmissionId === clientSubmissionId &&
    ['RECEIVED', 'RESOLVING', 'READY', 'NEEDS_CONNECTION', 'NEEDS_SELECTION', 'INVALID', 'RETRYABLE_FAILED', 'DISMISSED'].includes(row.state ?? '');
}
export function intakeLocalError(code?: string | null): string {
  if (code === 'INPUT_TOO_LARGE') return 'The shared text is too long. Share only the order details, up to 20,000 characters.';
  if (code === 'INPUT_EXPIRED') return 'This saved share expired after seven days. Share the order again to continue.';
  if (code === 'LOCAL_RECORD_UNREADABLE') return 'This saved share could not be read. Discard this copy and share the original order again.';
  if (code === 'UNSUPPORTED_LEGACY_ATTACHMENT') return 'This older share contains a file. Share the order text or link again to add it.';
  if (code === 'EMPTY_INPUT' || code === 'UNSUPPORTED_INPUT') return 'This app did not share order text or a link. Copy the order details and use Paste order details.';
  return 'Saved on this device. Open PackProof with a connection to finish adding it.';
}

export interface SubmissionDraft { itemTitle: string; quantity: string; externalReference: string; physicalFulfillment: boolean | null; paid: boolean | null; fulfillmentScope: 'FULL_ORDER' | 'PARTIAL' | 'MULTI_PARCEL' | 'UNKNOWN' }
export function confirmedSubmissionDetails(draft: SubmissionDraft) {
  const quantity = Number(draft.quantity);
  if (!draft.itemTitle.trim() || draft.itemTitle.length > 200 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000 || draft.externalReference.length > 200)
    throw new Error('Enter an item description, quantity, and a valid order reference.');
  if (typeof draft.physicalFulfillment !== 'boolean' || typeof draft.paid !== 'boolean' || !['FULL_ORDER', 'PARTIAL', 'MULTI_PARCEL'].includes(draft.fulfillmentScope)) throw new Error('Confirm the payment and packing details shown below.');
  return { confirmed: true as const, details: { itemTitle: draft.itemTitle.trim(), quantity, ...(draft.externalReference.trim() ? { externalReference: draft.externalReference.trim() } : {}), physicalFulfillment: draft.physicalFulfillment, paid: draft.paid, fulfillmentScope: draft.fulfillmentScope } };
}
