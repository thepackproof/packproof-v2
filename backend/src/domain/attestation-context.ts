import { canonicalize } from "../canonical.js";
import type { Database } from "../db/database.js";
import { sha256Hex } from "../hash.js";
import { DomainError } from "./errors.js";
import { loadTransactionView } from "./transactions.js";

/** Only material submission facts are signed; display/update timestamps are not. */
export async function attestationContext(db: Database, transactionId: string) {
  const t = await loadTransactionView(db, transactionId);
  const { importedAt: _importedAt, ...provenance } = t.provenance ?? {};
  const snapshot = {
    transactionId, externalReference: t.externalReference, transactionDate: t.transactionDate,
    itemTitle: t.itemTitle, itemDescription: t.itemDescription, quantity: t.quantity,
    transactionValue: t.transactionValue, currency: t.currency,
    shipping: t.shipping, items: t.items, provenance,
  };
  return { contextVersion: 1, transactionId, contextSha256: sha256Hex(canonicalize(snapshot)), statementVersion: 1 };
}
export function readAttestationContext(payload: string): {contextVersion?: number; transactionId?: string; contextSha256?: string} {
  try { return JSON.parse(payload); } catch { return {}; }
}
export async function assertAttestationContextCurrent(db: Database, transactionId: string, payload: string): Promise<void> {
  const signed = readAttestationContext(payload);
  const current = await attestationContext(db, transactionId);
  if (signed.contextVersion !== 1 || signed.transactionId !== transactionId || signed.contextSha256 !== current.contextSha256) {
    throw new DomainError('ATTESTATION_CONTEXT_CHANGED', 'The order or tracking details changed. Review them and confirm this recording again.', 409);
  }
}
