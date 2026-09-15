import type { SharedOrder } from '../../modules/packproof-order-share';
import { intakeEnvelope, isDurableIntakeAcknowledgment, maySubmitLocalOrder, type IntakeSubmission, type SubmissionEnvelope } from './submissions';

/** Transport seam: successful preview/parsing is deliberately insufficient to delete raw input. */
export async function deliverSharedOrder(input: {
  order: SharedOrder; accountId: string;
  ensureAccount: () => Promise<void>;
  submit: (envelope: SubmissionEnvelope) => Promise<IntakeSubmission>;
  acknowledge: (localId: string, serverId: string) => Promise<void>;
}): Promise<IntakeSubmission> {
  if (!maySubmitLocalOrder(input.order, input.accountId)) throw new Error('Choose the original account before adding this order.');
  await input.ensureAccount();
  const accepted = await input.submit(intakeEnvelope(input.order));
  if (!isDurableIntakeAcknowledgment(accepted, input.order.clientSubmissionId)) throw new Error('PackProof did not confirm this order. The shared copy remains on this device.');
  // A reply lost after this point replays the original clientSubmissionId, including when
  // native/JS delivery overlap. Acknowledgment always refers to the original local record.
  await input.acknowledge(input.order.id, accepted.submissionId);
  return accepted;
}
