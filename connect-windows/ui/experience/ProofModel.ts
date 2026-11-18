import type { OrderDetail } from "../workspace-types";

export type Row = Record<string, unknown>;
export const quantityStages = [
  ["orderedQuantity", "Ordered"],
  ["pickedQuantity", "Picked"],
  ["packedQuantity", "Packed"],
  ["loadedQuantity", "Loaded"],
  ["shippedQuantity", "Shipped"],
  ["acknowledgedQuantity", "Acknowledged"],
  ["backorderedQuantity", "Backordered"],
  ["returnedQuantity", "Returned"],
  ["cancelledQuantity", "Cancelled"],
] as const;
export type QuantityKey = (typeof quantityStages)[number][0];
export function scalar(v: unknown): string {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "";
}
export function obj(v: unknown): Row {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
}
export function rows(v: unknown): Row[] {
  return Array.isArray(v)
    ? v.filter((x): x is Row => x !== null && typeof x === "object" && !Array.isArray(x))
    : [];
}
export function text(row: Row, ...keys: string[]) {
  for (const k of keys) {
    const v = scalar(row[k]);
    if (v) return v;
  }
  return "";
}
export function human(key: string) {
  const v = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return v.charAt(0).toUpperCase() + v.slice(1);
}
export function dateLabel(v: string) {
  if (!v) return "Not reported";
  const d = new Date(v);
  return Number.isNaN(d.valueOf())
    ? v
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
const eventLabels: Record<string, [string, string]> = {
  order: ["Order confirmation", "order"],
  picking: ["Picking record", "list"],
  packing: ["Packing record", "packing"],
  evidence: ["Evidence captured", "photo"],
  label: ["Shipping label", "scan"],
  shipping: ["Shipping record", "shipping"],
  handoff: ["Handoff record", "delivery"],
  delivery: ["Delivery record", "delivery"],
  return: ["Return record", "records"],
  correction: ["Record correction", "activity"],
  load: ["Load confirmation", "shipping"],
  receiving: ["Receiving acknowledgment", "delivery"],
};
export const eventTitle = (k: string) => eventLabels[k]?.[0] || human(k || "Source record");
export const eventIcon = (k: string) => eventLabels[k]?.[1] || "file";
export type Ref = { type: string; id: string; namespace: string };
export const refKey = (r: Ref) => JSON.stringify([r.namespace, r.type, r.id]);
function references(row: Row): Ref[] {
  const out = new Map<string, Ref>();
  for (const v of [obj(row.entity), ...rows(row.references)]) {
    const ref = { type: text(v, "type"), id: text(v, "id"), namespace: text(v, "namespace") };
    if (ref.type && ref.id) out.set(refKey(ref), ref);
  }
  return [...out.values()];
}
export type Source = {
  key: string;
  title: string;
  origin: string;
  originId: string;
  kind: string;
  icon: string;
  fileName: string;
  locator: string;
  receipt: string;
  hash: string;
  originalStatus: string;
  eventTime: string;
  received: string;
  version: string;
  refs: Ref[];
  fields: Row;
  fieldLineage: Row;
  lines: Row[];
  row: Row;
  archived: boolean;
};
export type StageView = { text: string; unit: string; sources: Source[]; orderContext?: boolean };
export type Item = { id: string; label: string; unit: string; difference: string; row: Row };
export type Scope = { key: string; label: string; ref: Ref };
export type ProofModel = ReturnType<typeof modelProof>;
type Claim = { source: Source; line: Row };
function indexClaims(sources: Source[]) {
  const byLine = new Map<string, Claim[]>();
  for (const source of sources)
    for (const line of source.lines) {
      const id = text(line, "lineId");
      if (!id) continue;
      const list = byLine.get(id) || [];
      list.push({ source, line });
      byLine.set(id, list);
    }
  return byLine;
}
export function modelProof(detail: OrderDetail, names: Record<string, string> = {}) {
  const eventRows = rows(detail.events),
    evidenceRows = rows(detail.evidence);
  const indexed = (list: Row[]) =>
    new Map(list.filter((e) => text(e, "eventKey")).map((e) => [text(e, "eventKey"), e]));
  const evidenceByKey = indexed(evidenceRows),
    eventByKey = indexed(eventRows);
  function source(row: Row, key: string, event: Row, evidence: Row, archived: boolean): Source {
    const originId = text(row, "sourceId"),
      kind = text(event, "kind") || text(evidence, "eventKind", "recordKind"),
      fileName = text(row, "fileName");
    const fields = obj(evidence.fields ?? event.fields);
    // Merged current events can carry a quantity forward from an earlier revision.
    // Archived receipts only support quantities actually reported in their own allocation.
    const exactLines = Array.isArray(evidence.lines)
      ? rows(evidence.lines)
      : text(fields, "lineId") && quantityStages.some(([k]) => text(fields, k) !== "")
        ? [fields]
        : [];
    return {
      key,
      title: kind ? eventTitle(kind) : fileName || "Source record",
      origin:
        names[originId] || text(row, "sourceName", "sourceNamespace") || originId || "Source not reported",
      originId,
      kind,
      icon: eventIcon(kind),
      fileName,
      locator: text(row, "locator"),
      receipt: text(row, "receiptId"),
      hash: text(row, "originalSha256"),
      originalStatus: text(evidence, "originalStatus"),
      eventTime: text(event, "occurredAt") || text(evidence, "occurredAt"),
      received: text(row, "observedAt", "receivedAt"),
      version: text(row, "version"),
      refs: references(Object.keys(event).length ? event : evidence),
      fields,
      fieldLineage: obj(evidence.fieldLineage ?? event.fieldLineage),
      lines: archived ? exactLines : rows(event.lines),
      row,
      archived,
    };
  }
  const events = eventRows.map((e, i) =>
    source(e, "event-" + i, e, evidenceByKey.get(text(e, "eventKey")) || {}, false),
  );
  const records = evidenceRows.map((r, i) =>
    source(r, "record-" + i, eventByKey.get(text(r, "eventKey")) || {}, r, true),
  );
  const sources = records.length
    ? [...records, ...events.filter((e) => !evidenceByKey.has(text(e.row, "eventKey")))]
    : events;
  const scopeMap = new Map<string, Scope>();
  function mark(ref: Ref) {
    scopeMap.set(refKey(ref), { key: refKey(ref), label: human(ref.type) + " " + ref.id, ref });
  }
  for (const s of [...events, ...records]) {
    for (const r of s.refs) if (r.type === "shipment" || r.type === "delivery") mark(r);
    const ids = new Set(
      [
        ...s.lines.map((l) => text(l, "shipmentReference")),
        text(s.fields, "plannedShipmentReference"),
      ].filter(Boolean),
    );
    for (const id of ids) {
      if (s.refs.some((r) => r.type === "shipment" && r.id === id)) continue;
      const r = { type: "shipment", id, namespace: s.originId };
      s.refs.push(r);
      mark(r);
    }
  }
  const scopes = [...scopeMap.values()],
    labels = scopes.map((s) => s.label);
  for (const s of scopes)
    if (labels.filter((l) => l === s.label).length > 1) s.label += " · " + s.ref.namespace;
  const items = rows(detail.lines).map(
    (row, i): Item => ({
      id: text(row, "lineId") || "Line " + (i + 1),
      label: text(row, "title", "itemTitle", "description", "sku", "lineId") || "Item " + (i + 1),
      unit: text(row, "unit"),
      difference: text(row, "loadedAcknowledgedDiscrepancy", "orderedShippedDiscrepancy"),
      row,
    }),
  );
  return {
    detail,
    events,
    records,
    sources,
    scopes,
    items,
    reported: indexClaims(events),
    receipts: indexClaims(sources),
  };
}
export function inScope(s: Source, scope: string) {
  return !scope || s.refs.some((r) => refKey(r) === scope);
}
function allocatedTo(s: Source, scope: string, line: Row) {
  if (!scope) return true;
  const ref = s.refs.find((r) => refKey(r) === scope);
  if (!ref || text(s.row, "associationScope") === "shared") return false;
  const code = text(line, ref.type === "shipment" ? "shipmentReference" : "deliveryReference");
  if (code) return code === ref.id && s.refs.filter((r) => r.type === ref.type && r.id === code).length === 1;
  return s.refs.filter((r) => r.type === ref.type).length === 1;
}
function currentReceipts(model: ProofModel, item: Item, key: QuantityKey) {
  const groups = new Map<string, Claim[]>();
  for (const c of model.receipts.get(item.id) || []) {
    if (!Object.hasOwn(c.line, key)) continue;
    const source = c.source,
      event = text(source.row, "eventId");
    const group =
      event && source.originId && !text(source.row, "eventKey").startsWith("order_conflict_")
        ? JSON.stringify([source.originId, event])
        : source.key;
    const list = groups.get(group) || [];
    list.push(c);
    groups.set(group, list);
  }
  const latest: Claim[] = [];
  for (const list of groups.values()) {
    if (list.length < 2 || !list.every((c) => /^\d{1,30}$/.test(c.source.version))) latest.push(...list);
    else {
      const version = list.reduce(
        (max, c) => (BigInt(c.source.version) > max ? BigInt(c.source.version) : max),
        0n,
      );
      latest.push(...list.filter((c) => BigInt(c.source.version) === version));
    }
  }
  return latest.filter((c) => text(c.line, key) !== "");
}
export function quantity(model: ProofModel, item: Item, key: QuantityKey, scope: string): StageView {
  const retained = currentReceipts(model, item, key);
  const sources = [
    ...new Set(retained.filter((c) => allocatedTo(c.source, scope, c.line)).map((c) => c.source)),
  ];
  if (!scope) return { text: text(item.row, key), unit: item.unit, sources };
  const values = (model.reported.get(item.id) || [])
    .filter((c) => allocatedTo(c.source, scope, c.line) && text(c.line, key) !== "")
    .map((c) => c.line);
  if (values.length === 1) return { text: text(values[0], key), unit: text(values[0], "unit"), sources };
  if (values.length) return { text: values.length + " reports", unit: "", sources };
  if (key === "orderedQuantity" && text(item.row, key))
    return {
      text: text(item.row, key),
      unit: item.unit,
      sources: [...new Set(retained.map((c) => c.source))],
      orderContext: true,
    };
  return { text: "", unit: "", sources: [] };
}
function decimal(value: string) {
  if (!/^\d{1,18}(?:\.\d{1,9})?$/.test(value)) return null;
  const [int, fraction = ""] = value.split(".");
  return BigInt(int + fraction.padEnd(9, "0"));
}
function scopedDifference(m: ProofModel, i: Item, scope: string) {
  for (const [a, b, label] of [
    ["loadedQuantity", "acknowledgedQuantity", "loaded and acknowledged"],
    ["orderedQuantity", "shippedQuantity", "ordered and shipped"],
  ] as const) {
    const left = quantity(m, i, a, scope),
      right = quantity(m, i, b, scope);
    if (left.orderContext || right.orderContext || !left.unit || left.unit !== right.unit) continue;
    const av = decimal(left.text),
      bv = decimal(right.text);
    if (av === null || bv === null || av === bv) continue;
    const skus = new Set(
      (m.reported.get(i.id) || [])
        .filter(
          (c) => allocatedTo(c.source, scope, c.line) && (text(c.line, a) !== "" || text(c.line, b) !== ""),
        )
        .map((c) => text(c.line, "sku"))
        .filter(Boolean),
    );
    if (skus.size > 1) continue;
    const digits = String(av > bv ? av - bv : bv - av).padStart(10, "0"),
      fraction = digits.slice(-9).replace(/0+$/, "");
    return (
      digits.slice(0, -9) +
      (fraction ? "." + fraction : "") +
      " " +
      left.unit +
      " difference between " +
      label +
      " quantities"
    );
  }
  return "";
}
export function itemsInScope(model: ProofModel, scope: string) {
  if (!scope) return model.items;
  const ids = new Set(
    model.events.flatMap((s) =>
      s.lines.filter((l) => allocatedTo(s, scope, l)).map((l) => text(l, "lineId")),
    ),
  );
  return model.items
    .filter((i) => ids.has(i.id))
    .map((i) => ({ ...i, difference: scopedDifference(model, i, scope) }));
}
export function stagesFor(items: Item[], model: ProofModel, scope: string) {
  const stages = quantityStages.filter(([k]) =>
    items.some((i) => quantity(model, i, k, scope).text || text(i.row, k + "State") === "not_due"),
  );
  return stages.length
    ? stages
    : quantityStages.filter(([k]) =>
        ["orderedQuantity", "pickedQuantity", "shippedQuantity", "acknowledgedQuantity"].includes(k),
      );
}
export const searchMatch = (q: string, ...parts: string[]) =>
  parts.join(" ").toLocaleLowerCase().includes(q.trim().toLocaleLowerCase());
