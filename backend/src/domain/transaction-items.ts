import { canonicalize } from "../canonical.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { asNullableNumber } from "./transaction-fields.js";

export interface TransactionItemRow {
  id: string;
  transaction_id: string;
  external_item_id: string | null;
  position: number;
  title: string | null;
  description: string | null;
  sku: string | null;
  quantity: string | number | null;
  unit_value: string | number | null;
  currency: string | null;
  metadata: unknown;
  created_at: Date | string;
}

export interface TransactionItemView {
  itemId: string | null;
  externalItemId: string | null;
  position: number;
  title: string | null;
  description: string | null;
  sku: string | null;
  quantity: number | null;
  unitValue: number | null;
  currency: string | null;
}

export interface TransactionItemWrite {
  externalItemId: string | null;
  position: number;
  title: string | null;
  description: string | null;
  sku: string | null;
  quantity: number | null;
  unitValue: number | null;
  currency: string | null;
  metadata?: Record<string, unknown>;
}

export function toTransactionItemView(row: TransactionItemRow): TransactionItemView {
  return {
    itemId: row.id,
    externalItemId: row.external_item_id,
    position: Number(row.position),
    title: row.title,
    description: row.description,
    sku: row.sku,
    quantity: asNullableNumber(row.quantity),
    unitValue: asNullableNumber(row.unit_value),
    currency: row.currency,
  };
}

/**
 * Legacy single-item columns remain display summaries. When no child rows
 * exist, synthesize a one-item view so older clients stay compatible.
 */
export function synthesizeItemsFromLegacy(input: {
  itemTitle: string | null;
  itemDescription: string | null;
  quantity: number | null;
  transactionValue: number | null;
  currency: string | null;
}): TransactionItemView[] {
  if (
    input.itemTitle == null &&
    input.itemDescription == null &&
    input.quantity == null &&
    input.transactionValue == null
  ) {
    return [];
  }
  return [
    {
      itemId: null,
      externalItemId: null,
      position: 1,
      title: input.itemTitle,
      description: input.itemDescription,
      sku: null,
      quantity: input.quantity,
      unitValue: input.transactionValue,
      currency: input.currency,
    },
  ];
}

export function itemsCanonical(items: TransactionItemWrite[]): string {
  return canonicalize(
    items
      .slice()
      .sort((a, b) => a.position - b.position || (a.externalItemId ?? "").localeCompare(b.externalItemId ?? ""))
      .map((item) => ({
        externalItemId: item.externalItemId,
        position: item.position,
        title: item.title,
        description: item.description,
        sku: item.sku,
        quantity: item.quantity,
        unitValue: item.unitValue,
        currency: item.currency,
      })),
  );
}

export async function listTransactionItems(
  db: Database,
  transactionId: string,
): Promise<TransactionItemView[]> {
  const found = await db.query<TransactionItemRow>(
    `SELECT * FROM transaction_items
      WHERE transaction_id = $1
      ORDER BY position ASC, id ASC`,
    [transactionId],
  );
  return found.rows.map(toTransactionItemView);
}

export async function replaceTransactionItems(
  db: Database,
  transactionId: string,
  items: TransactionItemWrite[],
  nowIso: string,
): Promise<void> {
  const existing = await db.query<TransactionItemRow>(
    `SELECT * FROM transaction_items
      WHERE transaction_id = $1
      ORDER BY position ASC, id ASC`,
    [transactionId],
  );
  const next = items
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((item, index) => ({
      ...item,
      position: item.position || index + 1,
    }));
  const currentWrites: TransactionItemWrite[] = existing.rows.map((row) => ({
    externalItemId: row.external_item_id,
    position: Number(row.position),
    title: row.title,
    description: row.description,
    sku: row.sku,
    quantity: asNullableNumber(row.quantity),
    unitValue: asNullableNumber(row.unit_value),
    currency: row.currency,
  }));
  if (itemsCanonical(currentWrites) === itemsCanonical(next)) {
    return;
  }
  await db.query(`DELETE FROM transaction_items WHERE transaction_id = $1`, [transactionId]);
  await insertTransactionItems(db, transactionId, next, nowIso);
}

export async function insertTransactionItems(
  db: Database,
  transactionId: string,
  items: TransactionItemWrite[],
  nowIso: string,
): Promise<void> {
  for (const [index, item] of items.entries()) {
    await db.query(
      `INSERT INTO transaction_items (
         id, transaction_id, external_item_id, position, title, description,
         sku, quantity, unit_value, currency, metadata, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
      [
        newId("itm"),
        transactionId,
        item.externalItemId,
        item.position || index + 1,
        item.title,
        item.description,
        item.sku,
        item.quantity,
        item.unitValue,
        item.currency,
        JSON.stringify(item.metadata ?? {}),
        nowIso,
      ],
    );
  }
}
