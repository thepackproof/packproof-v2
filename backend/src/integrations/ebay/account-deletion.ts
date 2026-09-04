import { createHash, createVerify } from "node:crypto";
import { DomainError } from "../../domain/errors.js";
import { ebayApiBaseUrl, type EbayEnvironment } from "./constants.js";
import { basicAuthHeader, ebayTokenUrl } from "./oauth.js";

const PUBLIC_KEY_CACHE_TTL_MS = 60 * 60 * 1000;
const PUBLIC_KEY_CACHE_MAX = 100;
const publicKeyCache = new Map<string, { key: string; expiresAt: number }>();

export function ebayDeletionChallengeResponse(input: {
  challengeCode: string;
  verificationToken: string;
  endpoint: string;
}): string {
  return createHash("sha256")
    .update(`${input.challengeCode}${input.verificationToken}${input.endpoint}`, "utf8")
    .digest("hex");
}

export interface EbayDeletionSignatureVerificationInput {
  payload: unknown;
  signatureHeader: string | null | undefined;
  environment: EbayEnvironment;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}

/**
 * Verify the ECC signature eBay attaches to modern JSON notifications.
 *
 * eBay's X-EBAY-SIGNATURE value is base64-encoded JSON containing a key id
 * and base64 signature. The key id is resolved through the Notification API,
 * cached for one hour, and used to verify the JSON payload before PackProof
 * performs any account mutation.
 *
 * The payload serialization intentionally mirrors eBay's official Node event
 * notification SDK (`JSON.stringify(message)`) rather than re-canonicalizing
 * the object. This keeps verification compatible with eBay's signing flow.
 */
export async function verifyEbayDeletionNotificationSignature(
  input: EbayDeletionSignatureVerificationInput,
): Promise<void> {
  const signatureHeader = input.signatureHeader?.trim();
  if (!signatureHeader) {
    throw invalidWebhookSignature("Missing X-EBAY-SIGNATURE header");
  }

  const decoded = decodeSignatureHeader(signatureHeader);
  const fetchImpl = input.fetchImpl ?? fetch;
  const nowMs = input.nowMs ?? Date.now();
  const publicKey = await resolvePublicKey({
    environment: input.environment,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    keyId: decoded.kid,
    fetchImpl,
    nowMs,
  });

  let verified = false;
  try {
    const verifier = createVerify("sha1");
    verifier.update(JSON.stringify(input.payload), "utf8");
    verifier.end();
    verified = verifier.verify(formatPublicKey(publicKey), decoded.signature, "base64");
  } catch {
    throw invalidWebhookSignature("eBay webhook signature could not be verified");
  }

  if (!verified) {
    throw invalidWebhookSignature("eBay webhook signature is invalid");
  }
}

export function parseEbayDeletionNotification(body: unknown): {
  notificationId: string;
  username: string | null;
  userId: string | null;
} {
  const record = asRecord(body);
  const notification = asRecord(record.notification);
  const data = asRecord(notification.data);
  const notificationId =
    asString(notification.notificationId) ?? asString(record.notificationId);
  if (!notificationId) {
    throw new DomainError("INVALID_WEBHOOK", "eBay deletion notification is missing an id", 400);
  }
  return {
    notificationId,
    username: asString(data.username),
    userId: asString(data.userId),
  };
}

function decodeSignatureHeader(value: string): { kid: string; signature: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
  } catch {
    throw invalidWebhookSignature("X-EBAY-SIGNATURE is malformed");
  }
  const record = asRecord(parsed);
  const kid = asString(record.kid);
  const signature = asString(record.signature);
  if (!kid || !signature || kid.length > 256 || signature.length > 4096) {
    throw invalidWebhookSignature("X-EBAY-SIGNATURE is malformed");
  }
  return { kid, signature };
}

async function resolvePublicKey(input: {
  environment: EbayEnvironment;
  clientId: string;
  clientSecret: string;
  keyId: string;
  fetchImpl: typeof fetch;
  nowMs: number;
}): Promise<string> {
  const cacheKey = `${input.environment}:${input.keyId}`;
  const cached = publicKeyCache.get(cacheKey);
  if (cached && cached.expiresAt > input.nowMs) {
    return cached.key;
  }
  if (cached) {
    publicKeyCache.delete(cacheKey);
  }

  const applicationToken = await getApplicationToken(input);
  const response = await input.fetchImpl(
    `${ebayApiBaseUrl(input.environment)}/commerce/notification/v1/public_key/${encodeURIComponent(input.keyId)}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${applicationToken}`,
      },
    },
  );
  const payload = await readJson(response);
  if (!response.ok) {
    throw verificationUnavailable(`eBay public key retrieval failed with status ${response.status}`);
  }
  const key = asString(asRecord(payload).key);
  if (!key) {
    throw verificationUnavailable("eBay public key response did not contain a key");
  }

  prunePublicKeyCache(input.nowMs);
  publicKeyCache.set(cacheKey, {
    key,
    expiresAt: input.nowMs + PUBLIC_KEY_CACHE_TTL_MS,
  });
  return key;
}

async function getApplicationToken(input: {
  environment: EbayEnvironment;
  clientId: string;
  clientSecret: string;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const response = await input.fetchImpl(ebayTokenUrl(input.environment), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(input.clientId, input.clientSecret),
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }).toString(),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw verificationUnavailable(`eBay application token request failed with status ${response.status}`);
  }
  const token = asString(asRecord(payload).access_token);
  if (!token) {
    throw verificationUnavailable("eBay application token response did not contain an access token");
  }
  return token;
}

async function readJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw verificationUnavailable("eBay webhook verification response could not be read");
  }
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw verificationUnavailable("eBay webhook verification response was not valid JSON");
  }
}

function formatPublicKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed.includes("-----BEGIN PUBLIC KEY-----")) {
    throw verificationUnavailable("eBay returned an invalid public key");
  }
  return trimmed
    .replace(/-----BEGIN PUBLIC KEY-----\s*/, "-----BEGIN PUBLIC KEY-----\n")
    .replace(/\s*-----END PUBLIC KEY-----/, "\n-----END PUBLIC KEY-----");
}

function prunePublicKeyCache(nowMs: number): void {
  for (const [key, value] of publicKeyCache) {
    if (value.expiresAt <= nowMs) {
      publicKeyCache.delete(key);
    }
  }
  while (publicKeyCache.size >= PUBLIC_KEY_CACHE_MAX) {
    const oldest = publicKeyCache.keys().next().value as string | undefined;
    if (!oldest) {
      break;
    }
    publicKeyCache.delete(oldest);
  }
}

function invalidWebhookSignature(message: string): DomainError {
  return new DomainError("INVALID_WEBHOOK_SIGNATURE", message, 412);
}

function verificationUnavailable(message: string): DomainError {
  return new DomainError("WEBHOOK_VERIFICATION_UNAVAILABLE", message, 503);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
