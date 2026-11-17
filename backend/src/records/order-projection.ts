import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { DomainError } from '../domain/errors.js';
import { strictBody } from '../platform/organizations.js';
import { boundedText } from './order-workspace.js';
const kinds = ['order', 'picking', 'packing', 'evidence', 'label', 'handoff', 'delivery', 'return', 'correction'];
const entityTypes = ['order', 'order_line', 'warehouse_order', 'shipment', 'package', 'tracking', 'event', 'artifact', 'return', 'load', 'pallet', 'label', 'delivery', 'handoff', 'pick', 'packing', 'warehouse', 'document', 'photo', 'task'];
const quantityFields = ['orderedQuantity', 'pickedQuantity', 'packedQuantity', 'shippedQuantity', 'returnedQuantity', 'cancelledQuantity'] as const;
function reference(v: unknown) {
  const b = strictBody(v, ['namespace', 'type', 'id']);
  if (!entityTypes.includes(String(b.type))) throw new DomainError('PROFILE_AMBIGUOUS', 'Choose a supported entity type for this source.', 422);
  return {
    namespace: boundedText(b.namespace, 'reference namespace'),
    type: String(b.type),
    id: boundedText(b.id, 'external identity')
  };
}
type Ref = ReturnType<typeof reference>;
// This versioned profile spells tracking namespaces as carrier / account / period.
// A bare tracking number may accompany an explicit package reference but cannot bridge separate observations.
const canBridge = (r: Ref) => r.type !== 'tracking' || /^[^/]+\s*\/\s*[^/]+\s*\/\s*[^/]+$/.test(r.namespace);
type Scalar = string | null | boolean;
type Line = Record<string, string | null> & {
  lineId: string;
};
export const refKey = (ref: Ref) => sha256Hex(canonicalize([ref.namespace, ref.type, ref.id]));
function parseLine(v: unknown): Line {
  const b = strictBody(v, ['lineId', 'sku', 'unit', ...quantityFields]);
  const line: Line = {
    lineId: boundedText(b.lineId, 'order line')
  };
  for (const [key, val] of Object.entries(b)) {
    if (key === 'lineId') continue;
    if (val === null || val === '') {
      line[key] = val;
      continue;
    }
    const value = boundedText(val, key);
    if (quantityFields.some(q => q === key) && !/^\d{1,18}(?:\.\d{1,9})?$/.test(value)) throw new DomainError('PROFILE_AMBIGUOUS', 'Quantities require a nonnegative decimal string.', 422);
    line[key] = value;
  }
  return line;
}
export function parseRecord(input: unknown) {
  const b = strictBody(input, ['eventId', 'version', 'kind', 'entity', 'references', 'fields', 'lines', 'occurredAt', 'locator', 'sourceModifiedAt', 'fieldLineage', 'facilityId']);
  if (typeof b.eventId === 'string' && /^@(derivation|conflict):/.test(b.eventId)) throw new DomainError('INVALID_REQUEST', 'Use an external event identifier.', 400);
  const kind = b.kind === 'returns' ? 'return' : String(b.kind);
  if (!kinds.includes(kind) || !Array.isArray(b.references) || b.references.length > 32 || b.lines != null && (!Array.isArray(b.lines) || b.lines.length > 256)) throw new DomainError('PROFILE_AMBIGUOUS', 'The source record has unsupported relationships or line allocations.', 422);
  const entity = reference(b.entity),
    references = b.references.map(reference);
  if (kind === 'order' && references.some(r => r.type === 'order' && refKey(r) !== refKey(entity))) throw new DomainError('PROFILE_AMBIGUOUS', 'An order origin cannot identify another order as itself.', 422);
  if (kind === 'order' && entity.type !== 'order') throw new DomainError('PROFILE_AMBIGUOUS', 'An order origin needs a scoped order identity.', 422);
  const raw = b.fields;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 96) throw new DomainError('PROFILE_AMBIGUOUS', 'A bounded set of source fields is required.', 422);
  const fields: Record<string, Scalar> = Object.create(null);
  for (const [k, v] of Object.entries(raw)) {
    if (!k || k.length > 180 || ['__proto__', 'prototype', 'constructor'].includes(k) || !(v === null || typeof v === 'boolean' || typeof v === 'string' && v.length <= 4096)) throw new DomainError('PROFILE_AMBIGUOUS', 'Preserve exact field values as bounded source strings.', 422);
    fields[k] = v;
  }
  const timestamp = (v: unknown) => {
    if (v == null || v === '') return null;
    const s = boundedText(v, 'timestamp', 64);
    if (!/(?:Z|[+-]\d\d:\d\d)$/i.test(s) || !Number.isFinite(Date.parse(s))) throw new DomainError('PROFILE_AMBIGUOUS', 'A reported timestamp needs a validated offset.', 422);
    return s;
  };
  const locators: Record<string, string> = Object.create(null);
  if (b.fieldLineage != null) {
    if (typeof b.fieldLineage !== 'object' || Array.isArray(b.fieldLineage) || Object.keys(b.fieldLineage).length > 160) throw new DomainError('PROFILE_AMBIGUOUS', 'Provide bounded field lineage.', 422);
    for (const [k, v] of Object.entries(b.fieldLineage)) {
      if (['__proto__', 'constructor', 'prototype'].includes(k)) throw new DomainError('PROFILE_AMBIGUOUS', 'Invalid source field.', 422);
      locators[boundedText(k, 'field', 180)] = boundedText(v, 'field locator', 1600);
    }
  }
  return {
    facilityId: b.facilityId != null ? boundedText(b.facilityId, 'organization facility') : null,
    fieldLineage: locators,
    eventId: boundedText(b.eventId, 'event identity'),
    version: boundedText(b.version, 'event version'),
    kind,
    entity,
    references,
    fields,
    lines: (b.lines ?? []) as unknown[],
    occurredAt: timestamp(b.occurredAt),
    sourceModifiedAt: timestamp(b.sourceModifiedAt),
    locator: boundedText(b.locator, 'field lineage', 1600)
  };
}
export function normalizedRecord(input: unknown) {
  const record = parseRecord(input);
  return {
    ...record,
    lines: record.lines.map(parseLine)
  };
}
export type OrderRecord = ReturnType<typeof normalizedRecord>;
export interface StoredEvent {
  id: string;
  source_id: string;
  record: OrderRecord;
  receipt_id: string;
  original_sha256: string;
  file_name: string;
  profile_version: string;
  received_at: string | Date;
  override?: string | null;
}
export interface Root {
  proof_id: string;
  source_id: string;
  root_key: string;
  order_reference: string;
}
type Merged = StoredEvent & {
  history: StoredEvent[];
};
function latest(events: StoredEvent[]) {
  const groups = new Map<string, StoredEvent[]>();
  for (const e of events) {
    const key = canonicalize([e.source_id, e.record.eventId, e.id.startsWith('order_conflict_') ? e.id : '']);
    const group = groups.get(key) ?? [];
    group.push(e);
    groups.set(key, group);
  }
  const merged: Merged[] = [];
  for (const group of groups.values()) {
    if (group.length > 1 && !group.every(e => /^\d{1,30}$/.test(e.record.version))) {
      // Incomparable versions stay reviewable with separate retained receipts.
      for (const e of group) merged.push({
        ...e,
        history: [e]
      });
      continue;
    }
    group.sort((a, b) => BigInt(a.record.version || '0') < BigInt(b.record.version || '0') ? -1 : 1);
    const newest = group[group.length - 1],
      lines = new Map<string, Line>(),
      fields: OrderRecord['fields'] = Object.create(null);
    for (const e of group) {
      Object.assign(fields, e.record.fields);
      for (const line of e.record.lines) lines.set(line.lineId, {
        ...lines.get(line.lineId),
        ...line
      });
    }
    merged.push({
      ...newest,
      history: group,
      record: {
        ...newest.record,
        fields,
        lines: [...lines.values()]
      }
    });
  }
  return merged.sort((a, b) => a.id.localeCompare(b.id));
}
function add(map: Map<string, Set<string>>, key: string, value: string) {
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}
function lineage(e: StoredEvent) {
  return {
    facilityId: e.record.facilityId,
    eventKey: e.id,
    receiptId: e.receipt_id,
    eventId: e.record.eventId,
    version: e.record.version,
    sourceId: e.source_id,
    originalSha256: e.original_sha256,
    fileName: e.file_name,
    profileVersion: e.profile_version,
    locator: e.record.locator,
    observedAt: new Date(e.received_at).toISOString()
  };
}
// Source quantities allow up to nine decimal places. Keep all arithmetic exact
// through aggregation and comparison, including amounts above Number.MAX_SAFE_INTEGER.
function decimalAmount(value: string) {
  const [integer, fraction = ''] = value.split('.');
  return BigInt(integer + fraction.padEnd(9, '0'));
}
function decimalText(amount: bigint) {
  const digits = String(amount < 0n ? -amount : amount).padStart(10, '0');
  const fraction = digits.slice(-9).replace(/0+$/, '');
  return (amount < 0n ? '-' : '') + digits.slice(0, -9) + (fraction ? '.' + fraction : '');
}
function decimalSum(values: string[]) {
  return decimalText(values.reduce((sum, value) => sum + decimalAmount(value), 0n));
}
function compareOrderedAndShipped(line: Line, orderedUnits?: Set<string | null>, shippedUnits?: Set<string | null>) {
  const {orderedQuantity, shippedQuantity, unit} = line;
  if (!orderedQuantity || !shippedQuantity || !unit ||
      orderedUnits?.size !== 1 || !orderedUnits.has(unit) || shippedUnits?.size !== 1 || !shippedUnits.has(unit)) return;
  const difference = decimalAmount(orderedQuantity) - decimalAmount(shippedQuantity);
  line.orderedMinusShippedQuantity = decimalText(difference);
  if (difference === 0n) return;
  const amount = decimalText(difference < 0n ? -difference : difference);
  const displayUnit = unit === 'each' ? 'EA' : unit;
  const direction = difference > 0n ? 'more ordered than shipped' : 'more shipped than ordered';
  line.orderedShippedDiscrepancy = [amount, displayUnit, direction].join(' ');
}
/** Expand only explicitly identified business relationships. An order is a terminal,
 * so a consolidated shipment cannot turn one sales order into another. */
export function projectOrders(events: StoredEvent[], roots: Root[]) {
  const identity = (e: Merged) => canBridge(e.record.entity) ? refKey(e.record.entity) : 'isolated:' + e.id;
  const current = latest(events),
    anchors = new Map(roots.map(r => [r.root_key, r.proof_id])),
    explicit = new Map<string, Set<string>>(),
    parents = new Map<string, Set<string>>();
  for (const e of current) {
    const entity = identity(e);
    if (e.override !== undefined) {
      if (e.override) add(explicit, entity, e.override);
      continue;
    }
    const children = [e.record.entity, ...e.record.references.filter(r => r.type !== 'order' && canBridge(r))];
    const direct = e.record.references.filter(r => r.type === 'order').map(refKey);
    if (e.record.kind === 'order' && e.record.entity.type === 'order' && roots.some(r => r.root_key === entity && r.source_id === e.source_id)) direct.push(entity);
    for (const order of direct) if (anchors.has(order)) add(explicit, entity, anchors.get(order)!);
    for (const p of e.record.references.filter(r => r.type !== 'order' && canBridge(r))) {
      const key = refKey(p);
      if (e.record.entity.type !== 'order') add(parents, entity, key);
      // A label/packing bridge explicitly binds its tracking or contained package.
      if (['label', 'packing', 'picking'].includes(e.record.kind) && ['tracking', 'package', 'shipment', 'warehouse_order'].includes(p.type)) add(parents, key, entity);
    }
    // Explicit relationships from the order-origin identify its children as well.
    if (e.record.kind === 'order' && anchors.has(entity)) for (const c of children.filter(r => r.type !== 'order' && canBridge(r))) add(explicit, refKey(c), anchors.get(entity)!);
  }
  function resolve(start: string) {
    const seen = new Set<string>(),
      result = new Set<string>(),
      queue = [start];
    for (let at = 0; at < queue.length; at++) {
      const key = queue[at];
      if (seen.has(key)) continue;
      seen.add(key);
      const found = explicit.get(key);
      if (found?.size) {
        for (const id of found) result.add(id);
        continue;
      }
      for (const next of parents.get(key) ?? []) if (!seen.has(next)) queue.push(next);
    }
    return result;
  }
  const views = new Map<string, Merged[]>(),
    members = new Map<string, string[]>();
  for (const e of current) {
    const entity = identity(e),
      direct = e.record.references.filter(r => r.type === 'order');
    const matches = e.override !== undefined ? new Set(e.override ? [e.override] : []) : direct.length ? new Set(direct.every(r => anchors.has(refKey(r))) ? direct.map(r => anchors.get(refKey(r))!) : []) : e.record.entity.type === 'order' ? new Set(anchors.has(entity) && roots.find(r => r.root_key === entity)?.source_id === e.source_id ? [anchors.get(entity)!] : []) : resolve(entity);
    for (const id of matches) {
      const a = views.get(id) ?? [];
      a.push(e);
      views.set(id, a);
    }
    for (const original of e.history) members.set(original.id, [...matches]);
  }
  const projections = roots.map(root => {
    const used = views.get(root.proof_id) ?? [],
      events = used.map(e => ({
        ...e.record,
        ...lineage(e),
        associationScope: (members.get(e.id) ?? []).length > 1 ? 'shared' : 'order',
        lines: (members.get(e.id) ?? []).length > 1 ? [] : e.record.lines
      }));
    const claims = new Map<string, Map<string, Map<string, Set<string | null>>>>(),
      conflicts: string[] = [],
      quantityUnits = new Map<string, Set<string | null>>();
    for (const e of used) {
      if ((members.get(e.id) ?? []).length > 1) continue;
      for (const l of e.record.lines) {
        const values = claims.get(l.lineId) ?? new Map();
        claims.set(l.lineId, values);
        for (const [key, value] of Object.entries(l)) {
          if (key === 'lineId') continue;
          const allocations = values.get(key) ?? new Map();
          values.set(key, allocations);
          if (quantityFields.some(q => q === key)) {
            const coordinate = canonicalize([l.lineId, key]),
              units = quantityUnits.get(coordinate) ?? new Set();
            units.add(l.unit ?? null);
            quantityUnits.set(coordinate, units);
          }
          // Count a package/line allocation once even if several independent sources report it.
          const partition = key.endsWith('Quantity') && key !== 'orderedQuantity' ? refKey(e.record.entity) : 'line';
          const set = allocations.get(partition) ?? new Set();
          set.add(value);
          allocations.set(partition, set);
        }
      }
    }
    const lines: Line[] = [];
    for (const [lineId, values] of claims) {
      const line: Line = {
        lineId
      };
      for (const [key, partitions] of values) {
        const entries = [...partitions.values()];
        const units = quantityUnits.get(canonicalize([lineId, key]));
        if (entries.length > 1 && units && (units.size !== 1 || units.has(null))) {
          conflicts.push(`${lineId}: ${key} units`);
          continue;
        }
        if (entries.some(s => s.size !== 1)) {
          conflicts.push(`${lineId}: ${key}`);
          continue;
        }
        const v = entries.map(s => [...s][0]);
        if (v.length === 1) line[key] = v[0];else if (v.every((x): x is string => typeof x === 'string' && /^\d+(?:\.\d+)?$/.test(x))) line[key] = decimalSum(v);else if (new Set(v).size === 1) line[key] = v[0];else conflicts.push(`${lineId}: ${key}`);
      }
      if ((values.get('sku')?.get('line')?.size ?? 0) <= 1) {
        compareOrderedAndShipped(line, quantityUnits.get(canonicalize([lineId, 'orderedQuantity'])),
          quantityUnits.get(canonicalize([lineId, 'shippedQuantity'])));
      }
      lines.push(line);
    }
    const evidence = used.flatMap(e => e.history.map(v => ({
      ...lineage(v),
      kind: 'derived_excerpt',
      entity: v.record.entity,
      originalStatus: v.profile_version === 'packproof.partner-order-history/v1' ? 'original_unavailable' : 'retained',
      fieldLineage: v.record.fieldLineage,
      fields: v.record.fields
    }))).sort((a, b) => a.receiptId.localeCompare(b.receiptId) || a.locator.localeCompare(b.locator));
    return {
      proofId: root.proof_id,
      orderReference: root.order_reference,
      facilities: [...new Set(used.map(e => e.record.facilityId).filter((id): id is string => !!id))].sort(),
      lines: lines.sort((a, b) => a.lineId.localeCompare(b.lineId)),
      events: events.sort((a, b) => (a.occurredAt ?? a.observedAt).localeCompare(b.occurredAt ?? b.observedAt) || a.eventId.localeCompare(b.eventId)),
      evidence,
      conflicts: conflicts.sort()
    };
  });
  return {
    projections,
    members
  };
}
