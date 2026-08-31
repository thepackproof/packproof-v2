import { createHmac, timingSafeEqual } from "node:crypto";
import { webhookSignatureInvalid } from "../../domain/integration-errors.js";

const SIGNATURE_PREFIX = "hmac-sha256-hex=";

export function easypostWebhookSignatureHeader(secret: string, rawBody: Buffer): string {
  return `${SIGNATURE_PREFIX}${easypostWebhookHexDigest(secret, rawBody)}`;
}

export function easypostWebhookHexDigest(secret: string, rawBody: Buffer): string {
  const encodedSecret = Buffer.from(secret.normalize("NFKD"), "utf8");
  return createHmac("sha256", encodedSecret).update(correctedEventBody(rawBody), "utf8").digest("hex");
}

export function verifyEasyPostWebhookSignature(input: {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  webhookSecret: string;
}): void {
  const provided = headerValue(input.headers, "x-hmac-signature") ?? headerValue(input.headers, "X-Hmac-Signature");
  if (!provided) {
    throw webhookSignatureInvalid();
  }
  const expected = easypostWebhookSignatureHeader(input.webhookSecret, input.rawBody);
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw webhookSignatureInvalid();
  }
}

function correctedEventBody(rawBody: Buffer): string {
  return rawBody.toString("utf8").replace(/("weight":\s*)(\d+)(\s*)(?=,|\})/g, "$1$2.0");
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const found = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(found)) {
    return found[0] ?? null;
  }
  return found ?? null;
}
