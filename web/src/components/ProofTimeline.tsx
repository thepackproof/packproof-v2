import { useState } from "react";
import { useViewState } from "../navigation-context";
import type { ChronologyEntry } from "../api/types";
import { chronologyCategoryLabel } from "@packproof/copy/chronology";
import { activityTitle, groupRecordActivity, sortedRecordEvents, type AuditEntry } from "../presentation/proof-record";
import { Glyph } from "../site/Brand";

export const sortedChronology = sortedRecordEvents;

export function ProofTimeline({ entries, finalizedAt, onSelect, audit = [] }: {
  entries: ChronologyEntry[];
  finalizedAt?: string | null;
  onSelect?: (entry: ChronologyEntry) => void;
  audit?: AuditEntry[];
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useViewState(`timeline.${window.location.pathname}.filter`, "ALL");
  const ordered = sortedChronology(entries);
  const categories = ["ALL", ...new Set(ordered.map(entry => entry.category))];
  const selected = categories.includes(filter) ? filter : "ALL";
  const visible = ordered.filter(entry => selected === "ALL" || entry.category === selected);
  const groups = groupRecordActivity(visible, audit);
  const labels: Record<string, string> = { ALL: "All events", PROOF: "Proof", SHIPMENT: "Shipment", COMMERCE: "Order" };
  return <div className="proof-timeline">
    {categories.length > 2 && <div className="timeline-filters" aria-label="Timeline filters">{categories.map(category => <button key={category} aria-pressed={selected === category} onClick={() => setFilter(category)}>{labels[category] || category}<span>{category === "ALL" ? ordered.length : ordered.filter(entry => entry.category === category).length}</span></button>)}</div>}
    {groups.length === 0 ? <div className="timeline-empty"><Glyph name="clock" size={25} /><strong>No activity recorded yet.</strong></div> : <ol className="proof-timeline-list">
      {groups.map((group, index) => {
        const entry = group.entries[0];
        const date = new Date(entry.occurredAt);
        const validDate = Number.isFinite(date.getTime());
        const day = validDate ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "Time unavailable";
        const previous = groups[index - 1]?.entries[0];
        const newDay = !previous || new Date(previous.occurredAt).toDateString() !== date.toDateString();
        const core = entry.eventType === "PROOF_FINALIZED";
        const afterCore = entry.category === "SHIPMENT" && finalizedAt && date.getTime() > Date.parse(finalizedAt);
        const content = <><div className="timeline-card-top"><span className={`timeline-source source-${entry.category.toLowerCase()}`}>{chronologyCategoryLabel(entry.category, entry.source, entry.provider, entry.eventType)}</span>{core && <span className="timeline-preserved"><Glyph name="shield" size={13} /> Locked</span>}{onSelect && <Glyph size={16} />}</div><strong>{activityTitle(entry)}</strong>{entry.description && entry.eventType !== "PROOF_FINALIZED" && <p>{entry.description}</p>}{afterCore && <span className="timeline-supplement">Shipment update · recorded separately from the frozen core</span>}</>;
        return <li key={group.id} className={`proof-timeline-entry ${core ? "core-milestone" : ""}`}>
          <div className="timeline-date">{newDay && <strong>{day}</strong>}<time dateTime={validDate ? entry.occurredAt : undefined}>{validDate ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "—"}</time></div>
          <span className={`timeline-node node-${entry.category.toLowerCase()}`} aria-hidden="true"><Glyph name={core ? "shield" : group.access ? "activity" : entry.category === "SHIPMENT" ? "pin" : entry.category === "COMMERCE" ? "store" : "box"} size={15} /></span>
          {group.access ? <details className="timeline-card access-event-group" onToggle={event => { const open = event.currentTarget.open; setExpanded(previous => ({ ...previous, [group.id]: open })); }}><summary>{group.entries.length} access event{group.entries.length === 1 ? "" : "s"}</summary><p className="note">Events from the same known account and link are grouped within a 30-minute UTC window. This is an event count, not a count of people.</p>{expanded[group.id] && <ol>{group.entries.map(item => <li key={item.id}>{onSelect ? <button className="text-link" type="button" onClick={() => onSelect(item)}>{item.title}</button> : <strong>{item.title}</strong>}<EventSource entry={item} /></li>)}</ol>}</details>
            : onSelect ? <button id={`event-${entry.id}`} data-context-anchor={`event-${entry.id}`} className="timeline-card" onClick={() => onSelect(entry)}>{content}</button> : <div className="timeline-card">{content}</div>}
        </li>;
      })}
    </ol>}
    {entries.length > 0 && <details className="record-order-details full-audit-history" onToggle={event => { if (event.target === event.currentTarget) setHistoryOpen(event.currentTarget.open); }}><summary>Detailed history</summary>
      <p className="note">Exact timestamps include their UTC offset. This history retains individual event identifiers and supplied source details.</p>
      {historyOpen && <><ol>{ordered.map(entry => <li key={entry.id}>
        {onSelect ? <button className="text-link" type="button" onClick={() => onSelect(entry)}>{entry.title}</button> : <strong>{entry.title}</strong>}
        <EventSource entry={entry} />
      </li>)}</ol>
      {audit.length > 0 && <details><summary>Full audit records ({audit.length})</summary><ol>{audit.map(event => <li key={event.eventId}><strong>{event.eventType}</strong><time dateTime={event.at}>{event.at}</time><p>Event ID: {event.eventId}</p><p>Recorded actor: {event.actorUserId || "Not identified"}</p><pre>{JSON.stringify(event.data, null, 2)}</pre></li>)}</ol></details>}
    </>}
    </details>}
  </div>;
}

function EventSource({ entry }: { entry: ChronologyEntry }) {
  return <div className="timeline-event-source"><time dateTime={entry.occurredAt}>{entry.occurredAt}</time><span>{[entry.source, entry.provider].filter(Boolean).join(" · ")}</span><span>Event ID: {entry.id}</span>{entry.description && <p>{entry.description}</p>}</div>;
}
