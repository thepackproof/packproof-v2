import { DomainError } from "../domain/errors.js";

const OBJECT_KEY_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

export function evidenceObjectKey(proofId: string, evidenceId: string): string {
  return `evidence/${safeObjectKeySegment(proofId)}/${safeObjectKeySegment(evidenceId)}/object`;
}

export function safeObjectKeySegment(value: string): string {
  if (!OBJECT_KEY_SEGMENT.test(value)) {
    throw new DomainError("INVALID_OBJECT_KEY", "Invalid evidence object identity", 500);
  }
  return value;
}

export function assertSafeObjectKey(key: string): string {
  const normalized = key.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("..")) {
    throw new DomainError("INVALID_OBJECT_KEY", "Invalid object key", 400);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new DomainError("INVALID_OBJECT_KEY", "Invalid object key", 400);
  }
  return normalized;
}
