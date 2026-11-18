import { isDeepStrictEqual } from "node:util";
import type { AppDependencies } from "../app.js";
import type { Database } from "../db/database.js";
import { DomainError } from "../domain/errors.js";
import { sha256Hex } from "../hash.js";
import type { Installation } from "./agent-enrollments.js";
import { parseCsv } from "./csv.js";
import { agentOrderFilter, readOrder } from "./order-feed.js";
import type { OrderRecord } from "./order-projection.js";
import { activeScope, installationOperation } from "./order-workspace.js";

const maxTextBytes = 64 * 1024;
type SourceFact = {
  eventKey: string;
  receiptId: string;
  sourceId: string;
  originalSha256: string;
  locator: string;
  fileName: string;
  version: string;
  observedAt: string;
  profileVersion: string;
  originalStatus: string;
  associationScope?: string;
};
type LinkedArtifact = { receiptId: string; sourceId: string; generation: number; linkedByReceiptId: string };
type ReceiptRow = {
  record: OrderRecord;
  generation: number;
  object_key: string;
  object_version: string;
  media_type: string;
  exclusive: boolean;
  single_event: boolean;
};

function sameSourceValue(raw: unknown, saved: unknown) {
  return raw === saved || (typeof raw === "number" && Number.isFinite(raw) && String(raw) === saved);
}

// A file can contain more orders than its interpreted row. Show full text
// only if every original field is accounted for by this authorized record.
export function matchingSourceText(bytes: Buffer, fileName: string, record: OrderRecord): string | null {
  if (!bytes.length || bytes.length > maxTextBytes) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return null;
    const content = text.replace(/^\uFEFF/, "");
    if (/\.(?:csv|tsv)$/i.test(fileName)) {
      for (const delimiter of [",", ";", "\t"] as const) {
        const rows = parseCsv(content, delimiter);
        if (rows.length !== 2) continue;
        const [headers, values] = rows;
        if (headers.length !== values.length || !headers.length || new Set(headers).size !== headers.length)
          continue;
        if (headers.every((key, j) => Object.hasOwn(record.fields, key) && record.fields[key] === values[j]))
          return text;
      }
      return null;
    }
    if (!/\.(?:json|jsonl|ndjson)$/i.test(fileName)) return null;
    const parsed: unknown = JSON.parse(content);
    // Round-trip check prevents disclosure of duplicate keys discarded by JSON.parse.
    const compact = content.replace(/"(?:\\.|[^"\\])*"|[\t\r\n ]+/g, (token) =>
      token.startsWith('"') ? token : "",
    );
    if (JSON.stringify(parsed) !== compact) return null;
    const row = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
    if (!row || typeof row !== "object" || Array.isArray(row) || !Object.keys(row).length) return null;
    const canonicalEvent =
      Object.hasOwn(row, "entity") &&
      row.eventId === record.eventId &&
      row.version === record.version &&
      row.kind === record.kind &&
      isDeepStrictEqual(row.entity, record.entity);
    for (const [key, value] of Object.entries(row)) {
      if (key === "references") {
        if (!isDeepStrictEqual(value, record.references)) return null;
      } else if (key === "lines") {
        if (!Array.isArray(value) || value.length !== record.lines.length) return null;
        if (
          !value.every(
            (line, index) =>
              line &&
              typeof line === "object" &&
              !Array.isArray(line) &&
              Object.entries(line).every(
                ([name, v]) =>
                  Object.hasOwn(record.lines[index], name) && sameSourceValue(v, record.lines[index][name]),
              ),
          )
        )
          return null;
      } else if (canonicalEvent && Object.hasOwn(record, key)) {
        if (!isDeepStrictEqual(value, JSON.parse(JSON.stringify(record[key as keyof OrderRecord]))))
          return null;
      } else if (!Object.hasOwn(record.fields, key) || !sameSourceValue(value, record.fields[key]))
        return null;
    }
    return text;
  } catch {
    return null;
  }
}

export async function readOrderSource(
  deps: Pick<AppDependencies, "objectStore">,
  db: Database,
  installation: Installation,
  proofId: string,
  revision: string,
  eventKey: string,
) {
  const scope = await activeScope(db, installation);
  const proof = (await readOrder(db, await agentOrderFilter(db, installation), proofId, revision)) as {
    evidence: SourceFact[];
    originalArtifacts?: LinkedArtifact[];
  };
  const evidence = proof.evidence.find((e) => e.eventKey === eventKey);
  const missing = () =>
    new DomainError("SOURCE_NOT_FOUND", "This source record is unavailable for the selected revision.", 404);
  if (!evidence) throw missing();
  const operation = installationOperation(installation);
  const row = (
    await db.query<ReceiptRow>(
      `SELECT e.record,r.generation,r.object_key,r.object_version,r.media_type,
    (l.proof_ids=ARRAY[$7]::text[] AND NOT l.unresolved) AS exclusive,
    NOT EXISTS(SELECT 1 FROM record_order_events other WHERE other.receipt_id=r.id AND other.id<>e.id) AS single_event
    FROM record_order_events e JOIN record_order_receipts r ON r.id=e.receipt_id AND r.operation_key=e.operation_key AND r.source_id=e.source_id
    JOIN record_order_link_state l ON l.event_id=e.id AND l.operation_key=e.operation_key
    WHERE e.operation_key=$1 AND e.id=$2 AND r.id=$3 AND r.source_id=$4 AND r.original_sha256=$5 AND r.file_name=$6 FOR SHARE OF l`,
      [
        operation,
        eventKey,
        evidence.receiptId,
        evidence.sourceId,
        evidence.originalSha256,
        evidence.fileName,
        proofId,
      ],
    )
  ).rows[0];
  if (!row) throw missing();
  const { sourceId, receiptId, originalSha256, fileName, locator, version, observedAt, profileVersion } =
    evidence;
  const metadata = {
    eventKey,
    sourceId,
    receiptId,
    originalSha256,
    fileName,
    locator,
    version,
    observedAt,
    profileVersion,
  };
  if (!scope.scope.sources.some((s) => s.id === sourceId && s.generation === row.generation))
    return {
      ...metadata,
      kind: "derived_excerpt",
      reason: "original_scope_unavailable",
      fields: {},
      fieldLineage: {},
    };
  if (!row.exclusive || evidence.associationScope === "shared")
    return {
      ...metadata,
      kind: "derived_excerpt",
      reason: "shared_or_reassigned_record",
      fields: {},
      fieldLineage: {},
    };
  const attachments = (proof.originalArtifacts ?? []).filter(
    (a) =>
      a.linkedByReceiptId === receiptId &&
      scope.scope.sources.some((s) => s.id === a.sourceId && s.generation === a.generation),
  );
  const excerpt = {
    ...metadata,
    fields: row.record.fields,
    fieldLineage: row.record.fieldLineage ?? {},
    lines: row.record.lines,
    occurredAt: row.record.occurredAt,
    eventKind: row.record.kind,
    mediaType: row.media_type,
    ...(attachments.length === 1 && row.single_event ? { artifactReceiptId: attachments[0].receiptId } : {}),
  };
  if (
    evidence.originalStatus !== "retained" ||
    !row.single_event ||
    !/\.(json|jsonl|ndjson|csv|tsv)$/i.test(fileName)
  )
    return { ...excerpt, kind: "derived_excerpt", reason: "record_excerpt" };
  if (
    row.object_key !==
      "evidence/" + installation.organization_id + "/order-originals/committed/sha256-" + originalSha256 ||
    !row.object_version
  )
    throw missing();
  const object = await deps.objectStore.get(row.object_key, { versionId: row.object_version });
  if (!object || sha256Hex(object.body) !== originalSha256)
    throw new DomainError(
      "ORIGINAL_UNVERIFIED",
      "The retained original could not be verified. Retry this revision.",
      503,
    );
  const originalText = matchingSourceText(object.body, fileName, row.record);
  return originalText === null
    ? { ...excerpt, kind: "derived_excerpt", reason: "record_excerpt" }
    : { ...excerpt, kind: "original", originalText };
}
