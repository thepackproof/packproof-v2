import type { ChronologyEntry, ProofView } from '../v2-api';
import { recordEvidenceKey, type RecordEvidence } from './proof-record';

export type RecordSource = 'ALL' | 'COMMERCE' | 'EVIDENCE' | 'SHIPMENT';

/** A visual connection describes available records, never a verified physical handoff. */
export function connectedRecordSources(proof: ProofView, evidence: RecordEvidence[]) {
  return [
    { key: 'COMMERCE' as const, label: 'Order', available: Boolean(proof.transaction), detail: proof.transaction.provenance ? proof.transaction.provenance.provider || proof.transaction.provenance.source || 'Imported order context' : 'Participant-entered context' },
    { key: 'EVIDENCE' as const, label: 'Evidence', available: evidence.length > 0, detail: `${evidence.length} committed ${evidence.length === 1 ? 'original' : 'originals'}` },
    { key: 'SHIPMENT' as const, label: 'Shipment', available: Boolean(proof.shipmentObservations?.events.length), detail: 'Source-reported observations' },
  ].filter(source => source.available);
}

/** Selection identifies the exact source record, including conflicting duplicate representations. */
export function recordEventIdentity(entry: ChronologyEntry) {
  return JSON.stringify([entry.category, entry.source, entry.provider ?? null, entry.id,
    entry.occurredAt, entry.eventType, entry.relatedEntityId, entry.title, entry.description]);
}

/** Stable display order; original timestamps and canonical records are left unchanged. */
export function connectedRecordEvents(entries: ChronologyEntry[], source: RecordSource = 'ALL') {
  const seen = new Set<string>();
  return entries.filter(entry => {
    const identity = recordEventIdentity(entry);
    if (seen.has(identity)) return false;
    seen.add(identity);
    if (source === 'ALL') return true;
    if (source === 'EVIDENCE') return entry.category !== 'COMMERCE' && entry.category !== 'SHIPMENT';
    return entry.category === source;
  }).sort((a, b) => {
    const first = Date.parse(a.occurredAt), second = Date.parse(b.occurredAt);
    const time = (Number.isFinite(first) ? first : Infinity) - (Number.isFinite(second) ? second : Infinity);
    const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
    return (Number.isNaN(time) ? 0 : time) || compare(a.id, b.id) || compare(a.source, b.source) || compare(recordEventIdentity(a), recordEventIdentity(b));
  });
}

/** Resolve only explicit current-Proof associations. Chronology IDs usually name audit rows. */
export function originalForRecordEvent(entry: ChronologyEntry, evidence: RecordEvidence[], audit: ProofView['events'] = []) {
  const rows = (audit ?? []).filter(row => row.eventId === entry.id || row.eventId === entry.relatedEntityId);
  if (rows.length > 0) {
    if (rows.length !== 1 || entry.category !== 'PROOF') return undefined;
    const row = rows[0];
    if (row.eventType !== entry.eventType || row.at !== entry.occurredAt) return undefined;
    const evidenceId = typeof row.data.evidenceId === 'string' ? row.data.evidenceId :
      typeof row.data.relatedEvidenceId === 'string' ? row.data.relatedEvidenceId : null;
    const stageId = typeof row.data.stageId === 'string' ? row.data.stageId : null;
    if (!evidenceId || entry.eventType === 'LIFECYCLE_EVIDENCE_COMMITTED' && !stageId) return undefined;
    const matches = evidence.filter(item => item.evidenceId === evidenceId && (item.stageId ?? null) === stageId);
    if (matches.length !== 1) return undefined;
    const original = matches[0];
    if (['EVIDENCE_COMMITTED', 'LIFECYCLE_EVIDENCE_COMMITTED'].includes(entry.eventType) &&
      typeof row.data.sha256 === 'string' && row.data.sha256 !== original.sha256) return undefined;
    return original;
  }
  const matches = evidence.filter(item => entry.relatedEntityId === recordEvidenceKey(item) ||
    (!item.stageId && entry.relatedEntityId === item.evidenceId));
  return matches.length === 1 ? matches[0] : undefined;
}
