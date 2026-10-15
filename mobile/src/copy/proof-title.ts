/**
 * Display-only title resolution. The current API identifies the transaction
 * field, but does not expose provenance for the individual itemTitle value.
 * An email-shaped itemTitle may have been deliberately entered by its owner;
 * do not discard it by guessing its origin. Participant identity is never a
 * fallback input, and this helper never changes the stored transaction.
 */
import { proofReference } from './evidence-record';

export interface ProofTitleInput {
  proofId?: string;
  transaction: {
    itemTitle?: string | null;
    externalReference?: string | null;
  };
}

export interface ProofDisplayTitle {
  title: string;
  source: 'transaction-title' | 'order-reference' | 'untitled';
}

const text = (value: string | null | undefined) => value?.trim().replace(/\s+/g, ' ') ?? '';

export function resolveProofDisplayTitle(proof: ProofTitleInput): ProofDisplayTitle {
  const title = text(proof.transaction.itemTitle);
  if (title) return { title, source: 'transaction-title' };
  const reference = text(proof.transaction.externalReference);
  // An identity accidentally supplied as a reference must not become a title.
  if (reference && !/\S+@\S+\.\S+/.test(reference)) {
    return { title: `Order ${reference}`, source: 'order-reference' };
  }
  return { title: proof.proofId ? `Shipment Proof · ${proofReference(proof.proofId)}` : 'Shipment Proof', source: 'untitled' };
}

export function proofDisplayTitle(proof: ProofTitleInput): string {
  return resolveProofDisplayTitle(proof).title;
}
