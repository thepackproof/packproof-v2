import { createHmac } from "node:crypto";

export const PROGRAM_SCHEMA_VERSION = "packproof.program.v1" as const;
export const REFERENCE_PATTERN = /^pr_[a-f0-9]{32}$/;
export type Reference = string;
export type JsonRecord = Record<string, unknown>;

/** Derive references in the trusted application boundary, never in public clients.
 * Keep the dedicated analytics key in managed secrets, separate from signing keys.
 */
export function pseudonymizeReference(key: string | Buffer, namespace: string, identifier: string): Reference {
  if (Buffer.byteLength(key) < 32) throw new Error("ANALYTICS_KEY_TOO_SHORT");
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(namespace) || identifier.length === 0) throw new Error("INVALID_REFERENCE_INPUT");
  return `pr_${createHmac("sha256", key).update(JSON.stringify([namespace, identifier])).digest("hex").slice(0, 32)}`;
}

export function record(value: unknown, allowed: readonly string[], required: readonly string[], path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`INVALID_OBJECT:${path}`);
  const object = value as JsonRecord;
  // Reject rather than copy arbitrary metadata, messages, URLs or personal information.
  if (Object.keys(object).some(key => !allowed.includes(key))) throw new Error(`UNKNOWN_FIELD:${path}`);
  if (required.some(key => !(key in object))) throw new Error(`MISSING_FIELD:${path}`);
  return object;
}

export function reference(value: unknown, path: string): asserts value is Reference {
  if (typeof value !== "string" || !REFERENCE_PATTERN.test(value)) throw new Error(`INVALID_REFERENCE:${path}`);
}

export function timestamp(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`INVALID_TIMESTAMP:${path}`);
}

export function finiteNumber(value: unknown, path: string, minimum = 0, integer = false): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`INVALID_NUMBER:${path}`);
  }
}

export function enumValue(value: unknown, values: readonly string[], path: string): void {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`INVALID_ENUM:${path}`);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Same ID/same facts is a retry; changing facts requires a correction record,
 * not silently choosing whichever copy happens to arrive last.
 */
export function deduplicate<T>(rows: readonly T[], key: (row: T) => string, facts: (row: T) => unknown = row => row): T[] {
  const unique = new Map<string, T>();
  for (const row of rows) {
    const identity = key(row);
    const existing = unique.get(identity);
    if (existing && canonicalJson(facts(existing)) !== canonicalJson(facts(row))) throw new Error("ANALYTICS_DEDUPLICATION_CONFLICT");
    if (!existing) unique.set(identity, row);
  }
  return [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
}

export const EVENT_NAMES = ["upload.intent", "evidence.committed_pending_durability", "preservation.completed", "proof.finalized", "export.approved", "payment.settled", "capture.interaction"] as const;
export interface ProgramEvent {
  schemaVersion: typeof PROGRAM_SCHEMA_VERSION;
  eventRef: Reference;
  tenantRef: Reference;
  merchantRef: Reference;
  subjectRef: Reference;
  logicalAttemptRef: Reference;
  eventName: typeof EVENT_NAMES[number];
  occurredAt: string;
  authority: "server" | "billing" | "client";
  deviceClass: "s24_ultra" | "a16_5g" | "other_android" | "web" | "unknown";
  channel: "ebay" | "stripe" | "paypal" | "manual" | "other" | "unknown";
  outcome: "succeeded" | "failed" | "pending" | "cancelled";
  errorCode?: "network" | "authentication" | "quota" | "storage" | "capability" | "integrity" | "provider" | "cancelled" | "unknown";
}

export function validateProgramEvent(value: unknown): ProgramEvent {
  const required = ["schemaVersion", "eventRef", "tenantRef", "merchantRef", "subjectRef", "logicalAttemptRef", "eventName", "occurredAt", "authority", "deviceClass", "channel", "outcome"];
  const row = record(value, [...required, "errorCode"], required, "event");
  if (row.schemaVersion !== PROGRAM_SCHEMA_VERSION) throw new Error("UNSUPPORTED_ANALYTICS_SCHEMA");
  for (const field of ["eventRef", "tenantRef", "merchantRef", "subjectRef", "logicalAttemptRef"]) reference(row[field], field);
  timestamp(row.occurredAt, "occurredAt");
  enumValue(row.eventName, EVENT_NAMES, "eventName");
  enumValue(row.authority, ["server", "billing", "client"], "authority");
  enumValue(row.deviceClass, ["s24_ultra", "a16_5g", "other_android", "web", "unknown"], "deviceClass");
  enumValue(row.channel, ["ebay", "stripe", "paypal", "manual", "other", "unknown"], "channel");
  enumValue(row.outcome, ["succeeded", "failed", "pending", "cancelled"], "outcome");
  if ("errorCode" in row) enumValue(row.errorCode, ["network", "authentication", "quota", "storage", "capability", "integrity", "provider", "cancelled", "unknown"], "errorCode");
  const expected = row.eventName === "payment.settled" ? "billing" : row.eventName === "capture.interaction" ? "client" : "server";
  if (row.authority !== expected) throw new Error("INVALID_EVENT_AUTHORITY");
  if (["preservation.completed", "proof.finalized", "export.approved", "payment.settled"].includes(String(row.eventName)) && row.outcome !== "succeeded") {
    throw new Error("INVALID_AUTHORITATIVE_OUTCOME");
  }
  return row as unknown as ProgramEvent;
}

/** The caller must read the canonical transaction/outbox or verified billing inbox.
 * An authority property supplied by an HTTP client is never authorization.
 */
export function deduplicateProgramEvents(values: readonly unknown[]): ProgramEvent[] {
  const rows = deduplicate(values.map(validateProgramEvent), row => row.eventRef);
  return deduplicate(rows, row => row.eventName === "capture.interaction" ? row.eventRef
    : JSON.stringify([row.tenantRef, row.eventName, row.eventName === "upload.intent" ? row.logicalAttemptRef : row.subjectRef]),
  ({ eventRef: _eventRef, ...facts }) => facts);
}

export interface FinalizedProofUsage {
  schemaVersion: typeof PROGRAM_SCHEMA_VERSION;
  tenantRef: Reference;
  merchantRef: Reference;
  proofRef: Reference;
  durableFinalizationReceiptRef: Reference;
  planVersion: string;
  periodStart: string;
  periodEnd: string;
  finalizedAt: string;
  units: 1;
}

export function reconcileFinalizedProofUsage(values: readonly unknown[]): FinalizedProofUsage[] {
  const keys = ["schemaVersion", "tenantRef", "merchantRef", "proofRef", "durableFinalizationReceiptRef", "planVersion", "periodStart", "periodEnd", "finalizedAt", "units"];
  const rows = values.map(value => {
    const row = record(value, keys, keys, "usage");
    if (row.schemaVersion !== PROGRAM_SCHEMA_VERSION || row.units !== 1) throw new Error("INVALID_USAGE_UNIT");
    for (const field of ["tenantRef", "merchantRef", "proofRef", "durableFinalizationReceiptRef"]) reference(row[field], field);
    for (const field of ["periodStart", "periodEnd", "finalizedAt"]) timestamp(row[field], field);
    if (typeof row.planVersion !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(row.planVersion)) throw new Error("INVALID_PLAN_VERSION");
    if (String(row.periodStart) > String(row.finalizedAt) || String(row.finalizedAt) >= String(row.periodEnd)) throw new Error("INVALID_USAGE_PERIOD");
    return row as unknown as FinalizedProofUsage;
  });
  // The same transaction cannot be charged twice by changing plan or period.
  return deduplicate(rows, row => JSON.stringify([row.tenantRef, row.proofRef]));
}
