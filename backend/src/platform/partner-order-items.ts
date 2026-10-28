import { DomainError } from '../domain/errors.js';
import type { TransactionItemWrite } from '../domain/transaction-items.js';
import { strictBody } from './organizations.js';

/** The existing transaction_items representation, bounded at the partner boundary.
 * unitValue is a display amount in major currency units (NUMERIC(19,4)), never
 * an attested or computed payment amount. transaction.amount uses minor units. */
export function parsePartnerOrderItems(value: unknown): TransactionItemWrite[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    throw invalid('items must contain between 1 and 100 line items');
  const identifiers = new Set<string>(), positions = new Set<number>();
  return value.map((entry, index) => {
    const row = strictBody(entry, ['externalItemId','position','title','description','sku','quantity','unitValue','currency']);
    const title = optionalText(row.title, 'items.title', 200);
    if (!title) throw invalid('items.title is required');
    const externalItemId = optionalText(row.externalItemId, 'items.externalItemId', 200);
    if (externalItemId && identifiers.has(externalItemId)) throw invalid('items.externalItemId must be unique');
    if (externalItemId) identifiers.add(externalItemId);
    const position = row.position === undefined ? index + 1 : row.position;
    if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 1 || position > 100000 || positions.has(position))
      throw invalid('items.position must be a unique integer between 1 and 100000');
    positions.add(position);
    const quantity = row.quantity === undefined ? 1 : row.quantity;
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000)
      throw invalid('items.quantity must be an integer between 1 and 100000');
    let unitValue: number | null = null;
    if (row.unitValue !== undefined && row.unitValue !== null) {
      if (typeof row.unitValue !== 'number' || !Number.isFinite(row.unitValue) || row.unitValue < 0 ||
          row.unitValue > Number.MAX_SAFE_INTEGER / 10000 || Number(row.unitValue.toFixed(4)) !== row.unitValue)
        throw invalid('items.unitValue must be a non-negative major-unit amount with at most four decimals within the safe display range');
      unitValue = row.unitValue;
    }
    const currency = optionalText(row.currency, 'items.currency', 3);
    if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw invalid('items.currency must be a three-letter uppercase currency');
    if (unitValue !== null && currency === null) throw invalid('items.currency is required with items.unitValue');
    return {externalItemId, position, title,
      description: optionalText(row.description, 'items.description', 4000),
      sku: optionalText(row.sku, 'items.sku', 120), quantity, unitValue, currency};
  });
}

function optionalText(value: unknown, field: string, limit: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw invalid(`${field} must be a non-empty string of at most ${limit} characters`);
  return value.trim();
}
function invalid(message: string): DomainError {
  return new DomainError('INVALID_TRANSACTION_ITEMS', message, 400);
}
