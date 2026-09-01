import { createHash } from "node:crypto";
import { DomainError } from "../../domain/errors.js";

export function ebayDeletionChallengeResponse(input: {
  challengeCode: string;
  verificationToken: string;
  endpoint: string;
}): string {
  return createHash("sha256")
    .update(`${input.challengeCode}${input.verificationToken}${input.endpoint}`, "utf8")
    .digest("hex");
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

function asRecord(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
