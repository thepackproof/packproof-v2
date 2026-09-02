import { createHmac, timingSafeEqual } from "node:crypto";
import { webhookSignatureInvalid } from "../../domain/integration-errors.js";

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
