export interface ContextForm {
  externalReference: string;
  transactionDate: string;
  itemTitle: string;
  itemDescription: string;
  quantity: string;
  transactionValue: string;
  currency: string;
  carrier: string;
  service: string;
  trackingNumber: string;
  shipmentDate: string;
}

export const EMPTY_FORM: ContextForm = {
  externalReference: "",
  transactionDate: "",
  itemTitle: "",
  itemDescription: "",
  quantity: "",
  transactionValue: "",
  currency: "",
  carrier: "",
  service: "",
  trackingNumber: "",
  shipmentDate: "",
};

export interface TransactionLike {
  externalReference?: string | null;
  transactionDate?: string | null;
  itemTitle?: string | null;
  itemDescription?: string | null;
  quantity?: number | null;
  transactionValue?: number | null;
  currency?: string | null;
  shipping?: {
    carrier?: string | null;
    service?: string | null;
    trackingNumber?: string | null;
    shipmentDate?: string | null;
  } | null;
}

export function formFromTransaction(transaction: TransactionLike): ContextForm {
  return {
    externalReference: transaction.externalReference ?? "",
    transactionDate: transaction.transactionDate ?? "",
    itemTitle: transaction.itemTitle ?? "",
    itemDescription: transaction.itemDescription ?? "",
    quantity: transaction.quantity == null ? "" : String(transaction.quantity),
    transactionValue:
      transaction.transactionValue == null ? "" : String(transaction.transactionValue),
    currency: transaction.currency ?? "",
    carrier: transaction.shipping?.carrier ?? "",
    service: transaction.shipping?.service ?? "",
    trackingNumber: transaction.shipping?.trackingNumber ?? "",
    shipmentDate: transaction.shipping?.shipmentDate ?? "",
  };
}

export function parseOptionalInteger(raw: string, field: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new Error(`${field} must be a positive integer`);
  }
  return Number(trimmed);
}

export function parseOptionalAmount(raw: string, field: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be a number`);
  }
  return value;
}

export function parseContextForm(form: ContextForm): {
  transaction: {
    externalReference: string | null;
    transactionDate: string | null;
    itemTitle: string | null;
    itemDescription: string | null;
    quantity: number | null;
    transactionValue: number | null;
    currency: string | null;
  };
  shipping: {
    carrier: string | null;
    service: string | null;
    trackingNumber: string | null;
    shipmentDate: string | null;
  };
} {
  return {
    transaction: {
      externalReference: form.externalReference.trim() || null,
      transactionDate: form.transactionDate.trim() || null,
      itemTitle: form.itemTitle.trim() || null,
      itemDescription: form.itemDescription.trim() || null,
      quantity: parseOptionalInteger(form.quantity, "quantity"),
      transactionValue: parseOptionalAmount(form.transactionValue, "transaction value"),
      currency: form.currency.trim() || null,
    },
    shipping: {
      carrier: form.carrier.trim() || null,
      service: form.service.trim() || null,
      trackingNumber: form.trackingNumber.trim() || null,
      shipmentDate: form.shipmentDate.trim() || null,
    },
  };
}
