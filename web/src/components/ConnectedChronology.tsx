import { useEffect, useMemo, useRef, useState } from "react";
import type { CanonicalProof, ChronologyEntry } from "../api/types";
import { chronologyCategoryLabel, humanChronologyTitle } from "@packproof/copy/chronology";
import { Glyph } from "../site/Brand";

type Props = {
  proof: CanonicalProof;
  selectedId: string | null;
  onSelect: (entry: ChronologyEntry) => void;
  onOpenEvent?: (entry: ChronologyEntry) => void;
  onClose?: () => void;
};

export type ConnectedOriginal = CanonicalProof["evidence"][number] & { stageId: string | null; stageType?: string };
export function connectedEventIdentity(entry: ChronologyEntry) {
  return JSON.stringify([entry.category, entry.source, entry.provider ?? null, entry.id,
    entry.occurredAt, entry.eventType, entry.relatedEntityId, entry.title, entry.description]);
}
export function originalIdentity(item: ConnectedOriginal) { return item.stageId ? `${item.stageId}:${item.evidenceId}` : item.evidenceId; }
export function connectedOriginals(proof: CanonicalProof, committedOnly = false): ConnectedOriginal[] {
  return [
    ...proof.evidence.filter(item => !committedOnly || item.validationStatus === "COMMITTED").map(item => ({ ...item, stageId: null })),
    ...(proof.commerceStages ?? []).flatMap(stage => stage.evidence.filter(item => item.committedAt && item.sha256).map(item => ({ ...item, stageId: stage.stageId, stageType: stage.type, evidenceType: stage.type, validationStatus: "COMMITTED", digest: null }))),
  ];
}
/** Explicit current-Proof associations only. Backend chronology IDs normally identify audit rows. */
export function originalForChronologyEvent(proof: CanonicalProof, entry: ChronologyEntry) {
  const evidence = connectedOriginals(proof);
  const audit = (proof.events ?? []).filter(row => row.eventId === entry.id || row.eventId === entry.relatedEntityId);
  if (audit.length) {
    if (audit.length !== 1 || entry.category !== "PROOF" || entry.source !== "PACKPROOF" || entry.provider != null) return undefined;
    const row = audit[0];
    if (row.eventType !== entry.eventType || row.at !== entry.occurredAt) return undefined;
    const evidenceId = typeof row.data.evidenceId === "string" ? row.data.evidenceId : typeof row.data.relatedEvidenceId === "string" ? row.data.relatedEvidenceId : null;
    const stageId = typeof row.data.stageId === "string" ? row.data.stageId : null;
    if (!evidenceId || entry.eventType === "LIFECYCLE_EVIDENCE_COMMITTED" && !stageId) return undefined;
    const matches = evidence.filter(item => item.evidenceId === evidenceId && item.stageId === stageId);
    if (matches.length !== 1) return undefined;
    const original = matches[0];
    if (["EVIDENCE_COMMITTED", "LIFECYCLE_EVIDENCE_COMMITTED"].includes(entry.eventType) && typeof row.data.sha256 === "string" && row.data.sha256 !== original.sha256) return undefined;
    return original;
  }
  const matches = evidence.filter(item => entry.relatedEntityId === originalIdentity(item) || !item.stageId && entry.relatedEntityId === item.evidenceId);
  return matches.length === 1 ? matches[0] : undefined;
}
/** A projection of recorded source identities. The connection line conveys ordering only. */
export function ConnectedChronology({ proof, selectedId, onSelect, onOpenEvent, onClose }: Props) {
  const [wide, setWide] = useState(() => window.matchMedia?.('(min-width: 1200px)').matches === true);
  const [closedId, setClosedId] = useState<string | null>(null);
  const sourceButtons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    const query = window.matchMedia?.('(min-width: 1200px)');
    if (!query) return;
    const update = () => setWide(query.matches);
    query.addEventListener('change', update); update();
    return () => query.removeEventListener('change', update);
  }, []);
  const entries = useMemo(() => {
    const unique = new Map<string, ChronologyEntry>();
    for (const entry of proof.chronology ?? []) {
      const identity = connectedEventIdentity(entry);
      if (!unique.has(identity)) unique.set(identity, entry);
    }
    const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
    return [...unique.values()].sort((a, b) => {
      const first = Date.parse(a.occurredAt), second = Date.parse(b.occurredAt);
      const time = (Number.isFinite(first) ? first : Infinity) - (Number.isFinite(second) ? second : Infinity);
      return (Number.isNaN(time) ? 0 : time) || compare(a.id, b.id) || compare(a.source, b.source) || compare(connectedEventIdentity(a), connectedEventIdentity(b));
    });
  }, [proof.chronology]);
  const [visibleIds, setVisibleIds] = useState(() => new Set(entries.map(connectedEventIdentity)));
  const baselineReady = useRef(entries.length > 0);
  // The first nonempty response is a baseline, not a batch of "new" activity.
  // Subsequent deliveries require an explicit reveal so the read position stays stable.
  useEffect(() => {
    if (!baselineReady.current && entries.length) {
      baselineReady.current = true;
      setVisibleIds(new Set(entries.map(connectedEventIdentity)));
    }
  }, [entries]);
  const pending = baselineReady.current ? entries.filter(entry => !visibleIds.has(connectedEventIdentity(entry))) : [];
  const visible = entries.filter(entry => !baselineReady.current || visibleIds.has(connectedEventIdentity(entry)));
  const activeId = selectedId && closedId !== selectedId ? selectedId : null;
  const selectedAvailable = !activeId || entries.some(entry => connectedEventIdentity(entry) === activeId);
  const selectedEntry = visible.find(entry => connectedEventIdentity(entry) === activeId);
  const inspectorId = (entry: ChronologyEntry) => `source-${proof.proofId}-${encodeURIComponent(connectedEventIdentity(entry))}`;
  function closeInspector() {
    if (!activeId) return;
    const trigger = sourceButtons.current.get(activeId);
    setClosedId(activeId); onClose?.(); trigger?.focus({ preventScroll: true });
  }
  return <section className="eim-chronology" aria-label="Connected source chronology">
    <div className="eim-chronology-heading"><div><p className="eim-record-eyebrow">THE RECORD, CONNECTED</p><h2>Source history</h2></div><span>{entries.length}</span></div>
    <p className="eim-chronology-note">Order context, evidence and reported shipment events retain their own sources.</p>
    {pending.length > 0 && <button className="btn btn-secondary eim-new-activity" onClick={() => setVisibleIds(new Set(entries.map(connectedEventIdentity)))}>{pending.length} new event{pending.length === 1 ? '' : 's'} · Show activity</button>}
    {!selectedAvailable && <p role="status" className="eim-source-unavailable">The selected event is no longer available in this record view. Select another source to inspect it.</p>}
    <div className={`eim-chronology-layout${wide ? ' is-wide' : ''}`}>
      <div className="eim-chronology-events">
        {visible.length ? <ol className="eim-source-list">
          {visible.map(entry => {
            const identity = connectedEventIdentity(entry);
            const selected = activeId === identity;
            const date = new Date(entry.occurredAt);
            const valid = Number.isFinite(date.getTime());
            return <li key={identity} className={selected ? 'is-selected' : undefined}>
              <button ref={node => { if (node) sourceButtons.current.set(identity, node); else sourceButtons.current.delete(identity); }} className="eim-source-node" type="button" aria-expanded={selected} aria-controls={inspectorId(entry)} onClick={event => { setClosedId(null); onSelect(entry); event.currentTarget.focus({ preventScroll: true }); }} onKeyDown={event => { if (event.key === 'Escape' && selected) { event.preventDefault(); closeInspector(); } }} data-context-anchor={`source-event-${identity}`}>
                <span className={`eim-source-symbol eim-source-${entry.category.toLowerCase()}`} aria-hidden="true"><Glyph name={entry.category === 'SHIPMENT' ? 'box' : entry.category === 'COMMERCE' ? 'store' : /EVIDENCE|CAPTURE/.test(entry.eventType) ? 'film' : 'file'} size={17}/></span>
                <span className="eim-source-copy"><small>{chronologyCategoryLabel(entry.category, entry.source, entry.provider, entry.eventType)}</small><strong>{humanChronologyTitle(entry.eventType, entry.title)}</strong><time dateTime={valid ? entry.occurredAt : undefined}>{valid ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Time unavailable'}</time></span>
                <span className="eim-source-chevron" aria-hidden="true">{selected ? '−' : '+'}</span>
              </button>
              {!wide && selected && <SourceInspector key={identity} id={inspectorId(entry)} proof={proof} entry={entry} onOpenEvent={onOpenEvent} onClose={closeInspector}/>}
            </li>;
          })}
        </ol> : <div className="eim-source-empty"><Glyph name="clock" size={24}/><strong>No source events available</strong><p>Existing evidence remains available. No chronology is inferred from missing event data.</p></div>}
      </div>
      {wide && <aside className="eim-source-pane" aria-label="Selected source inspector">{selectedEntry ? <SourceInspector key={connectedEventIdentity(selectedEntry)} id={inspectorId(selectedEntry)} proof={proof} entry={selectedEntry} onOpenEvent={onOpenEvent} onClose={closeInspector}/> : <div className="eim-inspector-empty"><Glyph name="file" size={24}/><h3>Select a source</h3><p>Choose an event to inspect its origin, recorded times and supporting material here.</p></div>}</aside>}
    </div>
  </section>;
}
function SourceInspector({ id, proof, entry, onOpenEvent, onClose }: { id: string; proof: CanonicalProof; entry: ChronologyEntry; onOpenEvent?: (entry: ChronologyEntry) => void; onClose: () => void }) {
  const matchingAudit = (proof.events ?? []).filter(item => (item.eventId === entry.id || item.eventId === entry.relatedEntityId) && item.eventType === entry.eventType && item.at === entry.occurredAt);
  const statementCandidates = entry.category === "PROOF" && entry.source === "PACKPROOF" && entry.provider == null
    ? (proof.attestations ?? []).filter(item => matchingAudit.length === 1
      ? item.relatedEventId === matchingAudit[0].eventId || item.attestationId === matchingAudit[0].data.attestationId
      : matchingAudit.length === 0 && item.attestationId === entry.relatedEntityId && item.createdAt === entry.occurredAt)
    : [];
  const statement = statementCandidates.length === 1 ? statementCandidates[0] : undefined;
  const evidence = originalForChronologyEvent(proof, entry);
  const shipmentMatches = proof.shipmentObservations?.events.filter(item => (item.id === entry.relatedEntityId || item.id === entry.id) && item.source === entry.source && item.provider === entry.provider && item.occurredAt === entry.occurredAt && item.eventType === entry.eventType) ?? [];
  const shipment = shipmentMatches.length === 1 ? shipmentMatches[0] : undefined;
  const limitation = entry.category === "SHIPMENT"
    ? "This observation was reported by its named source. PackProof did not independently observe the physical delivery. Later reports remain separate from the finalized core."
    : statement ? "This is a participant's statement. It is not an independent assessment of the parcel or the item's authenticity."
    : entry.eventType === "PROOF_FINALIZED" ? "Finalization locks the evidence record. It does not independently authenticate physical goods or decide a dispute."
    : evidence?.validationStatus === "COMMITTED" ? "This is committed evidence. Its content and any participant statements remain distinct from independent verification."
    : evidence ? "This associated upload has not been committed. No preservation or completed record is confirmed by this event."
    : "This event records information from its named source. A connected timeline does not establish continuous physical custody.";
  return <section id={id} className="eim-source-inspector" aria-label={`Source details: ${entry.title}`} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
    <div className="eim-inspector-heading"><p className="eim-record-eyebrow">SOURCE DETAIL</p><button type="button" className="text-link" aria-label="Close source details" onClick={onClose}>Close</button></div>
    {entry.description && <p>{entry.description}</p>}
    {statement?.statementText && <blockquote>{statement.statementText}</blockquote>}
    <dl>
      <div><dt>Origin</dt><dd>{entry.source || "Not supplied"}{entry.provider ? ` · ${entry.provider}` : ""}</dd></div>
      <div><dt>{entry.category === "SHIPMENT" ? "Source-reported time" : "Recorded event time"}</dt><dd><time dateTime={Number.isFinite(Date.parse(entry.occurredAt)) ? entry.occurredAt : undefined}>{entry.occurredAt || "Not supplied"}</time></dd></div>
      {shipment?.observedAt && <div><dt>Ingested by PackProof</dt><dd><time dateTime={shipment.observedAt}>{shipment.observedAt}</time></dd></div>}
      {evidence?.receivedAt && <div><dt>Evidence received</dt><dd><time dateTime={evidence.receivedAt}>{evidence.receivedAt}</time></dd></div>}
      {evidence?.committedAt && <div><dt>Evidence committed</dt><dd><time dateTime={evidence.committedAt}>{evidence.committedAt}</time></dd></div>}
      <div><dt>Event identifier</dt><dd>{entry.id}</dd></div>
      {entry.relatedEntityId && <div><dt>Associated object</dt><dd>{entry.relatedEntityId}</dd></div>}
    </dl>
    {evidence && <p className="eim-source-association">{evidence.validationStatus === "COMMITTED" ? "Linked committed original: inspect it in the evidence viewer. Playback availability is checked separately." : "Associated evidence is not committed."}</p>}
    <p className="eim-source-limit">{limitation}</p>
    {onOpenEvent && <button className="text-link" type="button" onClick={() => onOpenEvent(entry)}>Open full event details</button>}
  </section>;
}
