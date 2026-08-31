import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { appendAudit } from "./audit.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import {
  asNullableNumber,
  changedEntries,
  parseShippingPatch,
  parseTransactionCreate,
  parseTransactionPatch,
  shippingWriteHasValues,
  toTransactionView,
  type ShippingWrite,
  type TransactionView,
} from "./transaction-fields.js";
import { provenanceFromIdentity } from "./provenance.js";
import type {
  ProofRow,
  ShippingRow,
  TransactionIntegrationIdentityRow,
  TransactionRow,
} from "./types.js";
import type { TransactionProvenanceView } from "./provenance.js";
import {
  listTransactionItems,
  synthesizeItemsFromLegacy,
  type TransactionItemView,
} from "./transaction-items.js";

export type { ShippingView, TransactionView } from "./transaction-fields.js";
export { toTransactionView } from "./transaction-fields.js";

export interface TransactionBundle {
  txn: TransactionRow;
  shipping: ShippingRow | null;
  proofId: string | null;
  proofStatus: string | null;
  buyerUserId: string | null;
  provenance: TransactionProvenanceView | null;
  items: TransactionItemView[];
}

export async function createTransaction(
  db: Database,
  clock: Clock,
  actorUserId: string,
  input: unknown,
): Promise<TransactionView> {
  const parsed = parseTransactionCreate(input);
  const externalReference = parsed.externalReference;

  return db.transaction(async (tx) => {
    if (externalReference) {
      const existing = await tx.query<TransactionRow>(
        `SELECT * FROM transactions WHERE external_reference = $1`,
        [externalReference],
      );
      if (existing.rows[0]) {
        return loadTransactionView(tx, existing.rows[0].id);
      }
    }

    const id = newId("txn");
    const now = clock.now().toISOString();
    try {
      await tx.query(
        `INSERT INTO transactions (
           id, external_reference, created_by, created_at, updated_at, transaction_metadata,
           transaction_date, item_title, item_description, quantity, transaction_value, currency
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          externalReference,
          actorUserId,
          now,
          now,
          JSON.stringify(parsed.metadata ?? {}),
          parsed.transactionDate,
          parsed.itemTitle,
          parsed.itemDescription,
          parsed.quantity,
          parsed.transactionValue,
          parsed.currency,
        ],
      );
    } catch (error) {
      if (externalReference && isUniqueViolation(error)) {
        const raced = await tx.query<TransactionRow>(
          `SELECT * FROM transactions WHERE external_reference = $1`,
          [externalReference],
        );
        if (raced.rows[0]) {
          return loadTransactionView(tx, raced.rows[0].id);
        }
      }
      throw error;
    }

    if (parsed.shipping && shippingWriteHasValues(parsed.shipping)) {
      await insertShipping(tx, id, parsed.shipping, now);
    }

    return loadTransactionView(tx, id);
  });
}

export async function getTransaction(
  db: Database,
  actorUserId: string,
  transactionId: string,
): Promise<TransactionView> {
  const bundle = await loadTransactionBundle(db, transactionId);
  if (!bundle) {
    throw new DomainError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
  }
  await assertCanReadTransaction(db, actorUserId, bundle);
  return toView(bundle);
}

export async function updateTransaction(
  db: Database,
  clock: Clock,
  actorUserId: string,
  transactionId: string,
  patch: unknown,
): Promise<TransactionView> {
  const parsed = parseTransactionPatch(patch);
  return db.transaction(async (tx) => {
    const locked = await lockTransactionContext(tx, transactionId);
    assertCanMutateTransaction(actorUserId, locked);
    assertNotFinalizedContext(locked);

    const next = {
      externalReference:
        parsed.externalReference !== undefined
          ? parsed.externalReference
          : locked.txn.external_reference,
      transactionDate:
        parsed.transactionDate !== undefined
          ? parsed.transactionDate
          : locked.txn.transaction_date,
      itemTitle: parsed.itemTitle !== undefined ? parsed.itemTitle : locked.txn.item_title,
      itemDescription:
        parsed.itemDescription !== undefined
          ? parsed.itemDescription
          : locked.txn.item_description,
      quantity:
        parsed.quantity !== undefined ? parsed.quantity : asNullableNumber(locked.txn.quantity),
      transactionValue:
        parsed.transactionValue !== undefined
          ? parsed.transactionValue
          : asNullableNumber(locked.txn.transaction_value),
      currency: parsed.currency !== undefined ? parsed.currency : locked.txn.currency,
    };

    const before = snapshotTransactionDetails(locked.txn);
    const after = {
      externalReference: next.externalReference,
      transactionDate: next.transactionDate,
      itemTitle: next.itemTitle,
      itemDescription: next.itemDescription,
      quantity: next.quantity,
      transactionValue: next.transactionValue,
      currency: next.currency,
    };
    const changed = changedEntries(before, after);
    if (Object.keys(changed).length === 0) {
      return toView(locked);
    }

    const now = clock.now();
    try {
      await tx.query(
        `UPDATE transactions
            SET external_reference = $2,
                transaction_date = $3,
                item_title = $4,
                item_description = $5,
                quantity = $6,
                transaction_value = $7,
                currency = $8,
                updated_at = $9
          WHERE id = $1`,
        [
          transactionId,
          next.externalReference,
          next.transactionDate,
          next.itemTitle,
          next.itemDescription,
          next.quantity,
          next.transactionValue,
          next.currency,
          now.toISOString(),
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainError(
          "TRANSACTION_REFERENCE_CONFLICT",
          "externalReference is already used",
          409,
        );
      }
      throw error;
    }

    if (locked.proofId) {
      await appendAudit(tx, {
        proofId: locked.proofId,
        actorUserId,
        eventType: "TRANSACTION_DETAILS_UPDATED",
        eventData: { transactionId, changed },
        at: now,
      });
    }
    // Transaction metadata is not Proof identity. Do not bind or rebind
    // proof_external_references from this update.

    return loadTransactionView(tx, transactionId);
  });
}

export async function updateShipping(
  db: Database,
  clock: Clock,
  actorUserId: string,
  transactionId: string,
  patch: unknown,
): Promise<TransactionView> {
  const parsed = parseShippingPatch(patch);
  return db.transaction(async (tx) => {
    const locked = await lockTransactionContext(tx, transactionId);
    assertCanMutateTransaction(actorUserId, locked);
    assertNotFinalizedContext(locked);

    const current = locked.shipping
      ? {
          carrier: locked.shipping.carrier,
          service: locked.shipping.service,
          trackingNumber: locked.shipping.tracking_number,
          shipmentDate: locked.shipping.shipment_date,
        }
      : {
          carrier: null,
          service: null,
          trackingNumber: null,
          shipmentDate: null,
        };
    const next: ShippingWrite = {
      carrier: parsed.carrier !== undefined ? parsed.carrier : current.carrier,
      service: parsed.service !== undefined ? parsed.service : current.service,
      trackingNumber:
        parsed.trackingNumber !== undefined ? parsed.trackingNumber : current.trackingNumber,
      shipmentDate: parsed.shipmentDate !== undefined ? parsed.shipmentDate : current.shipmentDate,
    };
    const changed = changedEntries(current, next);
    if (Object.keys(changed).length === 0) {
      return toView(locked);
    }

    const now = clock.now();
    const nowIso = now.toISOString();
    if (!locked.shipping) {
      await insertShipping(tx, transactionId, next, nowIso);
    } else {
      await tx.query(
        `UPDATE transaction_shipping
            SET carrier = $2,
                service = $3,
                tracking_number = $4,
                shipment_date = $5,
                updated_at = $6
          WHERE transaction_id = $1`,
        [
          transactionId,
          next.carrier,
          next.service,
          next.trackingNumber,
          next.shipmentDate,
          nowIso,
        ],
      );
    }

    if (locked.proofId) {
      await appendAudit(tx, {
        proofId: locked.proofId,
        actorUserId,
        eventType: "SHIPPING_DETAILS_UPDATED",
        eventData: { transactionId, changed },
        at: now,
      });
    }

    return loadTransactionView(tx, transactionId);
  });
}

export async function loadTransactionView(
  db: Database,
  transactionId: string,
): Promise<TransactionView> {
  const bundle = await loadTransactionBundle(db, transactionId);
  if (!bundle) {
    throw new DomainError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
  }
  return toView(bundle);
}

export async function loadTransactionBundle(
  db: Database,
  transactionId: string,
): Promise<TransactionBundle | null> {
  const result = await db.query<TransactionRow>(
    `SELECT * FROM transactions WHERE id = $1`,
    [transactionId],
  );
  const txn = result.rows[0];
  if (!txn) {
    return null;
  }
  return attachContext(db, txn);
}

async function attachContext(db: Database, txn: TransactionRow): Promise<TransactionBundle> {
  const shipping = await db.query<ShippingRow>(
    `SELECT * FROM transaction_shipping WHERE transaction_id = $1`,
    [txn.id],
  );
  const proof = await db.query<ProofRow>(
    `SELECT * FROM proofs WHERE transaction_id = $1`,
    [txn.id],
  );
  const proofRow = proof.rows[0] ?? null;
  let buyerUserId: string | null = null;
  if (proofRow) {
    const buyer = await db.query<{ user_id: string }>(
      `SELECT user_id FROM proof_participants WHERE proof_id = $1 AND role = 'BUYER'`,
      [proofRow.id],
    );
    buyerUserId = buyer.rows[0]?.user_id ?? null;
  }
  const identity = await db.query<TransactionIntegrationIdentityRow>(
    `SELECT * FROM transaction_integration_identities
      WHERE transaction_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [txn.id],
  );
  const storedItems = await listTransactionItems(db, txn.id);
  const items =
    storedItems.length > 0
      ? storedItems
      : synthesizeItemsFromLegacy({
          itemTitle: txn.item_title,
          itemDescription: txn.item_description,
          quantity: asNullableNumber(txn.quantity),
          transactionValue: asNullableNumber(txn.transaction_value),
          currency: txn.currency,
        });
  return {
    txn,
    shipping: shipping.rows[0] ?? null,
    proofId: proofRow?.id ?? null,
    proofStatus: proofRow?.status ?? null,
    buyerUserId,
    provenance: provenanceFromIdentity(identity.rows[0] ?? null, txn.transaction_metadata),
    items,
  };
}

export async function lockTransactionContext(
  db: Database,
  transactionId: string,
): Promise<TransactionBundle> {
  const txnResult = await db.query<TransactionRow>(
    `SELECT * FROM transactions WHERE id = $1 FOR UPDATE`,
    [transactionId],
  );
  const txn = txnResult.rows[0];
  if (!txn) {
    throw new DomainError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
  }
  await db.query(`SELECT id FROM transaction_shipping WHERE transaction_id = $1 FOR UPDATE`, [
    transactionId,
  ]);
  await db.query(`SELECT id FROM transaction_items WHERE transaction_id = $1 FOR UPDATE`, [
    transactionId,
  ]);
  const proof = await db.query<ProofRow>(
    `SELECT * FROM proofs WHERE transaction_id = $1 FOR UPDATE`,
    [transactionId],
  );
  return attachContext(db, txn);
}

export async function insertShipping(
  db: Database,
  transactionId: string,
  shipping: ShippingWrite,
  nowIso: string,
): Promise<void> {
  await db.query(
    `INSERT INTO transaction_shipping (
       id, transaction_id, carrier, service, tracking_number, shipment_date, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      newId("shp"),
      transactionId,
      shipping.carrier,
      shipping.service,
      shipping.trackingNumber,
      shipping.shipmentDate,
      nowIso,
      nowIso,
    ],
  );
}

async function assertCanReadTransaction(
  db: Database,
  actorUserId: string,
  bundle: TransactionBundle,
): Promise<void> {
  if (bundle.txn.created_by === actorUserId) {
    return;
  }
  if (!bundle.proofId) {
    throw new DomainError("PARTICIPANT_NOT_AUTHORIZED", "Not allowed to read this transaction", 403);
  }
  const viaProof = await db.query<{ id: string }>(
    `SELECT 1 AS id
       FROM proof_participants
      WHERE proof_id = $1 AND user_id = $2`,
    [bundle.proofId, actorUserId],
  );
  if (!viaProof.rows[0]) {
    throw new DomainError("PARTICIPANT_NOT_AUTHORIZED", "Not allowed to read this transaction", 403);
  }
}

function assertCanMutateTransaction(actorUserId: string, bundle: TransactionBundle): void {
  if (bundle.txn.created_by !== actorUserId) {
    throw new DomainError(
      "PARTICIPANT_NOT_AUTHORIZED",
      "Only the seller can update transaction or shipping details",
      403,
    );
  }
}

function assertNotFinalizedContext(bundle: TransactionBundle): void {
  if (bundle.proofStatus === "FINALIZED") {
    throw new DomainError(
      "PROOF_ALREADY_FINALIZED",
      "Finalized transaction and shipping facts cannot change",
      409,
    );
  }
}

function toView(bundle: TransactionBundle): TransactionView {
  return toTransactionView(bundle.txn, bundle.shipping, {
    proofId: bundle.proofId,
    proofStatus: bundle.proofStatus,
    buyerUserId: bundle.buyerUserId,
    provenance: bundle.provenance,
    items: bundle.items,
  });
}

function snapshotTransactionDetails(row: TransactionRow): Record<string, unknown> {
  return {
    externalReference: row.external_reference,
    transactionDate: row.transaction_date,
    itemTitle: row.item_title,
    itemDescription: row.item_description,
    quantity: asNullableNumber(row.quantity),
    transactionValue: asNullableNumber(row.transaction_value),
    currency: row.currency,
  };
}
