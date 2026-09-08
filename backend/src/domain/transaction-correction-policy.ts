import type { Database } from "../db/database.js";
import { DomainError } from "./errors.js";
import type { TransactionBundle } from "./transactions.js";

export async function hasBoundPackingCapture(db: Database, proofId: string | null): Promise<boolean> {
  if (!proofId) return false;
  const result = await db.query(`SELECT 1 FROM capture_sessions WHERE proof_id=$1 AND stage_id IS NULL
    AND workflow_step='PACKING' AND state <> 'CANCELLED' LIMIT 1`, [proofId]);
  return result.rows.length > 0;
}

/** Must run while the transaction and Proof locks are held. */
export async function assertTransactionCorrectionAllowed(db: Database, bundle: TransactionBundle): Promise<void> {
  const origin = bundle.provenance?.originalSource ?? bundle.provenance?.source;
  if (origin && ['MARKETPLACE_API','STOREFRONT_API','SHIPPING_PROVIDER_API'].includes(origin)) {
    throw new DomainError('IMPORTED_FACTS_READ_ONLY', 'These order details came from your sales channel and cannot be changed here.', 409);
  }
  if (await hasBoundPackingCapture(db, bundle.proofId)) {
    throw new DomainError('CAPTURE_CONTEXT_LOCKED', 'The order is already attached to a recording. Preserve this recording and review its details.', 409);
  }
}
