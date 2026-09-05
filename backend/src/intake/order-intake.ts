import { DomainError } from "../domain/errors.js";
import { sha256Hex } from "../hash.js";

export interface OrderDraft {
  externalReference: string | null;
  itemTitle: string | null;
  quantity: number | null;
  transactionValue: number | null;
  currency: string | null;
  shipping: { carrier: string | null; trackingNumber: string | null };
  metadata: {
    intake: {
      source: "paste" | "share" | "email";
      sourceSha256: string;
      confirmed: false;
      marketplace: string | null;
      buyer: string | null;
      seller: string | null;
    };
  };
}
/** Bounded, deterministic extraction. No network, LLM, HTML execution or inferred identity. */
export function previewOrderIntake(input: unknown): {
  draft: OrderDraft;
  warnings: string[];
  requiresConfirmation: true;
} {
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 20000)
    throw new DomainError("INVALID_INTAKE", "Paste between 1 and 20,000 characters", 400);
  const source = body.source ?? "paste";
  if (source !== "paste" && source !== "share" && source !== "email")
    throw new DomainError("INVALID_INTAKE", "Unsupported intake source", 400);
  const text = body.text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\r\n?/g, "\n");
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const warnings: string[] = [];
  function labeled(labels: string, max: number): string | null {
    const expression = new RegExp(`^(?:${labels})\\s*(?::|#|=)\\s*(.+)$`, "i");
    const candidates = [
      ...new Set(
        lines.flatMap((line) => {
          const match = expression.exec(line);
          return match ? [match[1].trim()] : [];
        }),
      ),
    ];
    if (candidates.length > 1) {
      warnings.push(`More than one ${labels.split("|")[0]} found; review the source.`);
      return null;
    }
    return candidates.length === 1 ? candidates[0].slice(0, max) : null;
  }
  const externalReference = labeled(
    "order(?: number| id| no\\.?)?|order confirmation|transaction(?: id)?",
    200,
  );
  const itemTitle = labeled("item(?: name| title)?|product(?: name)?|description", 200);
  const buyer = labeled("buyer|ship to|customer", 200);
  const seller = labeled("seller|sold by|merchant", 200);
  const carrier = labeled("carrier|shipping carrier", 100);
  const trackingNumber = labeled("tracking(?: number| id| no\\.?)?", 100);
  const quantityText = labeled("quantity|qty", 20);
  const quantity =
    quantityText &&
    /^\d+$/.test(quantityText) &&
    Number(quantityText) > 0 &&
    Number(quantityText) <= 100000
      ? Number(quantityText)
      : null;
  const total = labeled("order total|total|amount paid|price", 100);
  const explicitCurrency = labeled("currency", 3)?.toUpperCase() ?? null;
  const amountMatch = total?.match(
    /^(USD|EUR|GBP|CAD|AUD)?\s*([$€£])?\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*(USD|EUR|GBP|CAD|AUD)?$/i,
  );
  const statedCurrency = (amountMatch?.[1] || amountMatch?.[4])?.toUpperCase();
  const symbolCurrency = amountMatch?.[2] === "€" ? "EUR" : amountMatch?.[2] === "£" ? "GBP" : null;
  const currency =
    statedCurrency ||
    (explicitCurrency && /^[A-Z]{3}$/.test(explicitCurrency) ? explicitCurrency : null) ||
    symbolCurrency;
  const amount = amountMatch ? Number(amountMatch[3].replace(/,/g, "")) : null;
  const transactionValue =
    amount !== null && Number.isFinite(amount) && amount <= 1e12 ? amount : null;
  if (amount !== null && !currency)
    warnings.push("Confirm the currency; a dollar sign alone is ambiguous.");
  const marketplace = labeled("marketplace|platform", 100);
  if (!itemTitle) warnings.push("Add an item description before creating the Proof.");
  if (!externalReference)
    warnings.push("No unambiguous order number found; you can add it during review.");
  if (source === "email")
    warnings.push(
      "Forwarded content is an unverified order source; sender text does not establish identity.",
    );
  return {
    requiresConfirmation: true,
    warnings,
    draft: {
      externalReference,
      itemTitle,
      quantity,
      transactionValue,
      currency,
      shipping: { carrier, trackingNumber },
      metadata: {
        intake: {
          source,
          sourceSha256: sha256Hex(body.text),
          confirmed: false,
          marketplace,
          buyer,
          seller,
        },
      },
    },
  };
}
