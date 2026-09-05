import { createHmac, timingSafeEqual } from "node:crypto";
import { webhookSignatureInvalid } from "../../domain/integration-errors.js";
import { DomainError } from "../../domain/errors.js";

/** OAuth signs the sorted query; webhook signatures instead cover raw body bytes. */
export function verifyShopifyOAuthHmac(secret: string, query: Record<string, unknown>): void {
  const invalid = () => new DomainError("OAUTH_SIGNATURE_INVALID", "Shopify callback signature is invalid", 400);
  if (typeof query.hmac !== "string" || !/^[a-f0-9]{64}$/.test(query.hmac)) {
    throw invalid();
  }
  const pairs = Object.entries(query).filter(([key]) => key !== "hmac");
  // Repeated/nested parameters cannot be interpreted consistently across parsers.
  if (pairs.some(([key, value]) => typeof value !== "string" || /[&=\x00-\x1f]/.test(key))) {
    throw invalid();
  }
  const message = pairs.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join("&");
  const expected = createHmac("sha256", secret).update(message).digest();
  if (!timingSafeEqual(Buffer.from(query.hmac, "hex"), expected)) throw invalid();
}

export function shopifyWebhookHmac(secret: string, rawBody: Buffer): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

export function verifyShopifyWebhookHmac(input: {
  secret: string;
  rawBody: Buffer;
  header: string | string[] | undefined;
}): void {
  const provided = Array.isArray(input.header) ? input.header[0] : input.header;
  if (!provided) {
    throw webhookSignatureInvalid();
  }
  const expected = shopifyWebhookHmac(input.secret, input.rawBody);
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw webhookSignatureInvalid();
  }
}
