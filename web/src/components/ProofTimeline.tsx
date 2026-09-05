import { useViewState } from "../navigation-context";
import type { ChronologyEntry } from "../api/types";
import { chronologyCategoryLabel } from "@packproof/copy/chronology";
import { Glyph } from "../site/Brand";

export function sortedChronology(entries: ChronologyEntry[]) {
  return [...entries].sort((a, b) => {
    const first = Date.parse(a.occurredAt), second = Date.parse(b.occurredAt);
    return (Number.isFinite(first) ? first : Infinity) - (Number.isFinite(second) ? second : Infinity);
  });
}

export function ProofTimeline({ entries, finalizedAt, onSelect }: {
  entries: ChronologyEntry[];
  finalizedAt?: string | null;
  onSelect?: (entry: ChronologyEntry) => void;
}) {
  const [filter, setFilter] = useViewState(`timeline.${window.location.pathname}.filter`, "ALL");
  const ordered = sortedChronology(entries);
  const categories = ["ALL", ...new Set(ordered.map(entry => entry.category))];
  const selected = categories.includes(filter) ? filter : "ALL";
  const visible = ordered.filter(entry => selected === "ALL" || entry.category === selected);
  const labels: Record<string, string> = { ALL: "All events", PROOF: "Proof", SHIPMENT: "Shipment", COMMERCE: "Order" };
  return <div className="proof-timeline">
    {entries.length > 0 && <div className="timeline-filters" aria-label="Timeline filters">{categories.map(category => <button key={category} aria-pressed={selected === category} onClick={() => setFilter(category)}>{labels[category] || category}<span>{category === "ALL" ? entries.length : entries.filter(entry => entry.category === category).length}</span></button>)}</div>}
    {visible.length === 0 ? <div className="timeline-empty"><Glyph name="clock" size={25} /><strong>Your story starts here.</strong><p>Recorded events will appear in this timeline.</p></div> : <ol className="proof-timeline-list">
      {visible.map((entry, index) => {
        const date = new Date(entry.occurredAt);
        const validDate = Number.isFinite(date.getTime());
        const day = validDate ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "Time unavailable";
        const previous = visible[index - 1];
        const newDay = !previous || new Date(previous.occurredAt).toDateString() !== date.toDateString();
        const core = entry.eventType === "PROOF_FINALIZED";
        const afterCore = entry.category === "SHIPMENT" && finalizedAt && date.getTime() > Date.parse(finalizedAt);
        const content = <><div className="timeline-card-top"><span className={`timeline-source source-${entry.category.toLowerCase()}`}>{chronologyCategoryLabel(entry.category, entry.source, entry.provider, entry.eventType)}</span>{core && <span className="timeline-preserved"><Glyph name="shield" size={13} /> Preserved</span>}{onSelect && <Glyph size={16} />}</div><strong>{entry.title}</strong>{entry.description && <p>{entry.description}</p>}{afterCore && <span className="timeline-supplement">Shipment update · recorded separately from the frozen core</span>}</>;
        return <li key={entry.id} className={`proof-timeline-entry ${core ? "core-milestone" : ""}`}>
          <div className="timeline-date">{newDay && <strong>{day}</strong>}<time dateTime={validDate ? entry.occurredAt : undefined}>{validDate ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "—"}</time></div>
          <span className={`timeline-node node-${entry.category.toLowerCase()}`} aria-hidden="true"><Glyph name={core ? "shield" : entry.category === "SHIPMENT" ? "pin" : entry.category === "COMMERCE" ? "store" : "box"} size={15} /></span>
          {onSelect ? <button id={`event-${entry.id}`} data-context-anchor={`event-${entry.id}`} className="timeline-card" onClick={() => onSelect(entry)}>{content}</button> : <div className="timeline-card">{content}</div>}
        </li>;
      })}
    </ol>}
    <div className="timeline-end"><span /><span>Every recorded step, in order.</span></div>
  </div>;
}
