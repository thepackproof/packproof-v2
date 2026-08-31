import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { appendAudit } from "./audit.js";
import { createOrGetProof } from "./create-proof.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import { findProofIdByExternalReference, normalizeTenantKey } from "./external-references.js";
import {
  findTransactionIdentity,
  insertTransactionIdentity,
} from "./integration-identities.js";
import {
  importedPayloadFingerprint,
  parseImportedTransaction,
  type ParsedImportedTransaction,
} from "./imported-transaction.js";
import { getProofView, loadProof, type ProofView } from "./proofs.js";
import {
  readImportMetadata,
  tenantKeyForImport,
  writeImportMetadata,
  type ImportMetadata,
} from "./provenance.js";
import {
  asNullableNumber,
  changedEntries,
  shippingWriteHasValues,
  type ShippingWrite,
  type TransactionView,
} from "./transaction-fields.js";
import {
  insertShipping,
  loadTransactionView,
  lockTransactionContext,
} from "./transactions.js";
import type { ShippingRow, TransactionRow } from "./types.js";

export interface TransactionImportView {
  transaction: TransactionView;
  proof: ProofView | null;
  identity: {
    adapterKey: string;
    tenantKey: string;
    externalTransactionId: string;
    source: string;
  };
  created: boolean;
}

export async function importNormalizedTransaction(
  db: Database,
  clock: Clock,
  actorUserId: string,
  imported: unknown,
  options: { createProof?: boolean; adapterKey?: string } = {},
): Promise<TransactionImportView> {
  const parsed = parseImportedTransaction(imported);
  const adapterKey = options.adapterKey ?? parsed.provider;
  const createProof = options.createProof === true;
  const tenantKey = normalizeTenantKey(
    tenantKeyForImport(parsed.provider, parsed.provenance.source),
  );
  const fingerprint = importedPayloadFingerprint(parsed);

  return db.transaction(async (tx) => {
    const existingIdentity = await findTransactionIdentity(
      tx,
      tenantKey,
      parsed.externalTransactionId,
    );
    const boundProofId = await findProofIdByExternalReference(
      tx,
      tenantKey,
      parsed.externalTransactionId,
    );

    let transactionId: string;
    let created = false;

    if (existingIdentity) {
      transactionId = existingIdentity.transaction_id;
      const locked = await lockTransactionContext(tx, transactionId);
      if (locked.txn.created_by !== actorUserId) {
        throw new DomainError(
          "INTEGRATION_IDENTITY_CONFLICT",
          "External transaction identity is already owned by another seller",
          409,
        );
      }
      if (boundProofId && locked.proofId && boundProofId !== locked.proofId) {
        throw new DomainError(
          "EXTERNAL_REFERENCE_CONFLICT",
          "External transaction reference is already bound to another Proof",
          409,
        );
      }
      await applyImportedFacts(tx, clock, actorUserId, locked.txn.id, parsed, {
        adapterKey,
        tenantKey,
        fingerprint,
      });
    } else if (boundProofId) {
      const proof = await loadProof(tx, boundProofId);
      const locked = await lockTransactionContext(tx, proof.transaction_id);
      if (locked.txn.created_by !== actorUserId) {
        throw new DomainError(
          "EXTERNAL_REFERENCE_CONFLICT",
          "External transaction reference is already bound to another Proof",
          409,
        );
      }
      await insertTransactionIdentity(tx, {
        transactionId: locked.txn.id,
        tenantKey,
        externalTransactionId: parsed.externalTransactionId,
        adapterKey,
        source: parsed.provenance.source,
        at: clock.now(),
      });
      await applyImportedFacts(tx, clock, actorUserId, locked.txn.id, parsed, {
        adapterKey,
        tenantKey,
        fingerprint,
      });
      transactionId = locked.txn.id;
    } else {
      transactionId = await insertImportedTransaction(tx, clock, actorUserId, parsed, {
        adapterKey,
        tenantKey,
        fingerprint,
      });
      created = true;
    }

    if (createProof) {
      await createOrGetProof(tx, clock, actorUserId, transactionId);
    }

    const transaction = await loadTransactionView(tx, transactionId);
    const proof = transaction.proofId ? await getProofView(tx, transaction.proofId) : null;
    return {
      transaction,
      proof,
      identity: {
        adapterKey,
        tenantKey,
        externalTransactionId: parsed.externalTransactionId,
        source: parsed.provenance.source,
      },
      created,
    };
  });
}

async function insertImportedTransaction(
  db: Database,
  clock: Clock,
  actorUserId: string,
  parsed: ParsedImportedTransaction,
  ctx: { adapterKey: string; tenantKey: string; fingerprint: string },
): Promise<string> {
  const id = newId("txn");
  const now = clock.now();
  const nowIso = now.toISOString();
  const importMeta = buildImportMetadata(parsed, ctx, nowIso);
  try {
    await db.query(
      `INSERT INTO transactions (
         id, external_reference, created_by, created_at, updated_at, transaction_metadata,
         transaction_date, item_title, item_description, quantity, transaction_value, currency
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        parsed.externalTransactionId,
        actorUserId,
        nowIso,
        nowIso,
        JSON.stringify(writeImportMetadata({}, importMeta)),
        parsed.transactionDate,
        parsed.itemTitle,
        parsed.itemDescription,
        parsed.quantity,
        parsed.transactionValue,
        parsed.currency,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DomainError(
        "TRANSACTION_REFERENCE_CONFLICT",
        "externalTransactionId is already used as a transaction reference",
        409,
      );
    }
    throw error;
  }

  await insertTransactionIdentity(db, {
    transactionId: id,
    tenantKey: ctx.tenantKey,
    externalTransactionId: parsed.externalTransactionId,
    adapterKey: ctx.adapterKey,
    source: parsed.provenance.source,
    at: now,
  });

  if (parsed.shipping && shippingWriteHasValues(parsed.shipping)) {
    await insertShipping(db, id, parsed.shipping, nowIso);
  }
  return id;
}

async function applyImportedFacts(
  db: Database,
  clock: Clock,
  actorUserId: string,
  transactionId: string,
  parsed: ParsedImportedTransaction,
  ctx: { adapterKey: string; tenantKey: string; fingerprint: string },
): Promise<void> {
  const locked = await lockTransactionContext(db, transactionId);
  const beforeTxn = snapshotTransaction(locked.txn);
  const afterTxn = {
    externalReference: parsed.externalTransactionId,
    transactionDate: parsed.transactionDate,
    itemTitle: parsed.itemTitle,
    itemDescription: parsed.itemDescription,
    quantity: parsed.quantity,
    transactionValue: parsed.transactionValue,
    currency: parsed.currency,
  };
  const txnChanged = changedEntries(beforeTxn, afterTxn);
  const currentShipping = shippingSnapshot(locked.shipping);
  const nextShipping: ShippingWrite = parsed.shipping ?? currentShipping;
  const shipChanged =
    parsed.shipping && shippingWriteHasValues(parsed.shipping)
      ? changedEntries(currentShipping, nextShipping)
      : {};
  const previousMeta = readImportMetadata(locked.txn.transaction_metadata);
  const fingerprintUnchanged = previousMeta?.payloadSha256 === ctx.fingerprint;

  if (locked.proofStatus === "FINALIZED") {
    if (Object.keys(txnChanged).length > 0 || Object.keys(shipChanged).length > 0) {
      throw new DomainError(
        "PROOF_ALREADY_FINALIZED",
        "Imported data cannot mutate finalized Proof context",
        409,
      );
    }
    return;
  }

  if (
    Object.keys(txnChanged).length === 0 &&
    Object.keys(shipChanged).length === 0 &&
    fingerprintUnchanged
  ) {
    return;
  }

  const now = clock.now();
  const nowIso = now.toISOString();
  const importMeta = buildImportMetadata(parsed, ctx, nowIso, locked.txn.transaction_metadata);

  if (Object.keys(txnChanged).length > 0) {
    try {
      await db.query(
        `UPDATE transactions
            SET external_reference = $2,
                transaction_date = $3,
                item_title = $4,
                item_description = $5,
                quantity = $6,
                transaction_value = $7,
                currency = $8,
                transaction_metadata = $9::jsonb,
                updated_at = $10
          WHERE id = $1`,
        [
          transactionId,
          afterTxn.externalReference,
          afterTxn.transactionDate,
          afterTxn.itemTitle,
          afterTxn.itemDescription,
          afterTxn.quantity,
          afterTxn.transactionValue,
          afterTxn.currency,
          JSON.stringify(writeImportMetadata(locked.txn.transaction_metadata, importMeta)),
          nowIso,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainError(
          "TRANSACTION_REFERENCE_CONFLICT",
          "externalTransactionId is already used as a transaction reference",
          409,
        );
      }
      throw error;
    }
    if (locked.proofId) {
      await appendAudit(db, {
        proofId: locked.proofId,
        actorUserId,
        eventType: "TRANSACTION_IMPORTED",
        eventData: {
          transactionId,
          tenantKey: ctx.tenantKey,
          externalTransactionId: parsed.externalTransactionId,
          source: parsed.provenance.source,
          changed: txnChanged,
        },
        at: now,
      });
    }
  } else if (!fingerprintUnchanged) {
    await db.query(
      `UPDATE transactions
          SET transaction_metadata = $2::jsonb,
              updated_at = $3
        WHERE id = $1`,
      [
        transactionId,
        JSON.stringify(writeImportMetadata(locked.txn.transaction_metadata, importMeta)),
        nowIso,
      ],
    );
  }

  if (Object.keys(shipChanged).length > 0 && parsed.shipping) {
    if (!locked.shipping) {
      await insertShipping(db, transactionId, nextShipping, nowIso);
    } else {
      await db.query(
        `UPDATE transaction_shipping
            SET carrier = $2,
                service = $3,
                tracking_number = $4,
                shipment_date = $5,
                updated_at = $6
          WHERE transaction_id = $1`,
        [
          transactionId,
          nextShipping.carrier,
          nextShipping.service,
          nextShipping.trackingNumber,
          nextShipping.shipmentDate,
          nowIso,
        ],
      );
    }
    if (locked.proofId) {
      await appendAudit(db, {
        proofId: locked.proofId,
        actorUserId,
        eventType: "SHIPPING_DETAILS_IMPORTED",
        eventData: {
          transactionId,
          tenantKey: ctx.tenantKey,
          externalTransactionId: parsed.externalTransactionId,
          source: parsed.provenance.source,
          changed: shipChanged,
        },
        at: now,
      });
    }
  }
}

function buildImportMetadata(
  parsed: ParsedImportedTransaction,
  ctx: { adapterKey: string; tenantKey: string; fingerprint: string },
  nowIso: string,
  existingMetadata?: unknown,
): ImportMetadata {
  const previous = readImportMetadata(existingMetadata);
  return {
    source: parsed.provenance.source,
    adapterKey: ctx.adapterKey,
    provider: parsed.provider,
    tenantKey: ctx.tenantKey,
    sourceRecordId: parsed.provenance.sourceRecordId,
    importedAt: previous?.importedAt || parsed.provenance.importedAt || nowIso,
    payloadSha256: ctx.fingerprint,
    buyer: parsed.buyer,
  };
}

function snapshotTransaction(row: TransactionRow): Record<string, unknown> {
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

function shippingSnapshot(row: ShippingRow | null): ShippingWrite {
  return row
    ? {
        carrier: row.carrier,
        service: row.service,
        trackingNumber: row.tracking_number,
        shipmentDate: row.shipment_date,
      }
    : {
        carrier: null,
        service: null,
        trackingNumber: null,
        shipmentDate: null,
      };
}
