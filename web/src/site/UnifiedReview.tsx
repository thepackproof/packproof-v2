import { useEffect, useId, useRef, useState } from "react";
import { Glyph } from "./Brand";
import "./unified-review.css";

type SourceId = "order" | "camera" | "warehouse" | "dispatch" | "carrier";
type ReviewSource = {
  id: SourceId;
  icon: string;
  name: string;
  kind: string;
  file: string;
  time: string;
  event: string;
  summary: string;
  observation: string;
  limitation: string;
  flag?: string;
};
const reviewSources: ReviewSource[] = [
  { id: "order", icon: "store", name: "Order system", kind: "Transaction record", file: "order-1042.json", time: "09:41", event: "Order context added", summary: "Order #1042 / one ceramic mug", observation: "The illustrative order identifies the item and transaction reference used to organize this record.", limitation: "An order describes the transaction. It does not establish which item was packed." },
  { id: "camera", icon: "film", name: "Packing camera", kind: "Original recording", file: "packing-1042.mp4", time: "09:44", event: "Packing clip attached", summary: "Item and packing material visible", observation: "The example clip shows a mug being placed in a carton. The recording ends before a final seal is visible.", limitation: "A recording cannot establish an event outside its frame or after the clip ends.", flag: "Final seal not shown" },
  { id: "warehouse", icon: "box", name: "Warehouse scan", kind: "Reported scan", file: "station-scan.csv", time: "09:45", event: "Item scan associated", summary: "Example item reference: CER-1042", observation: "An illustrative station log reports an item scan associated with order #1042. Its source remains separate from the camera recording.", limitation: "A reported scan is system data. It is not direct visual confirmation of package contents." },
  { id: "dispatch", icon: "file", name: "Dispatch log", kind: "Reported label record", file: "dispatch-batch.csv", time: "09:48", event: "Label reference reviewed", summary: "Example label reference: #1043", observation: "The illustrative dispatch row names order #1043, while the shipment under review is #1042. The difference is flagged for a person to resolve.", limitation: "A mismatch is a review prompt. It does not determine whether the shipment was mislabeled.", flag: "Order reference differs" },
  { id: "carrier", icon: "pin", name: "Shipping provider", kind: "Carrier report", file: "carrier-events.json", time: "14:20", event: "Facility arrival reported", summary: "Example facility scan / next day", observation: "An illustrative carrier event extends the shipment chronology. Its reported time and source stay visible alongside the other evidence.", limitation: "A carrier scan reports shipment activity. It does not confirm what is inside the package." },
];

export function UnifiedReview() {
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState<SourceId>("camera");
  const inspectorId = useId();
  const record = useRef<HTMLDivElement>(null);
  const focusRecord = useRef(false);
  useEffect(() => {
    if (connected && focusRecord.current) { record.current?.focus(); focusRecord.current = false; }
  }, [connected]);
  function assemble() { focusRecord.current = true; setConnected(true); }
  const active = reviewSources.find(source => source.id === selected)!;
  return <section className="eim-unified-review" id="unified-review" data-scene>
    <div className="eim-home-width">
      <div className="ur-heading" data-reveal>
        <div><p className="ur-eyebrow"><span />YOUR SYSTEMS. SHARED CONTEXT.</p><h2>Keep the systems.<br /><span>Connect the evidence.</span></h2></div>
        <p>Camera footage. Warehouse logs. Orders and shipping reports. Bring supported sources into one shipment record, with original files and their origins kept in view.</p>
      </div>
      <div className={`ur-stage ${connected ? "ur-connected" : "ur-scattered"}`}>
        <div className="ur-toolbar">
          <div className="ur-toolbar-title"><Glyph name="panel" size={19} /><div><strong>THE SHIPMENT REVIEW</strong><span>Illustrative historical record / #1042</span></div></div>
          <div className="ur-mode" role="group" aria-label="Compare separate sources with a connected record"><button type="button" aria-pressed={!connected} onClick={() => setConnected(false)}>Scattered sources</button><button type="button" aria-pressed={connected} onClick={() => setConnected(true)}>One record <Glyph name="arrow" size={15} /></button></div>
        </div>
        <div className="ur-workspace">
          <div className="ur-source-column">
            <p className="ur-column-label">FIVE EXISTING SOURCES <span>05</span></p>
            <div className="ur-source-list">{reviewSources.map((source, index) => <button type="button" className={`ur-source ur-source-${source.id} ${selected === source.id ? "ur-selected" : ""}`} key={source.id} aria-pressed={selected === source.id} aria-controls={inspectorId} onClick={() => setSelected(source.id)}><span className="ur-source-icon"><Glyph name={source.icon} size={20} /></span><span className="ur-source-copy"><strong>{source.name}</strong><small>{source.kind}</small></span><span className={source.flag ? "ur-source-indicator ur-has-flag" : "ur-source-indicator"} aria-label={source.flag ? "Includes a review exception" : undefined}>{source.flag ? "!" : `0${index + 1}`}</span></button>)}</div>
            <p className="ur-source-hint"><Glyph name="info" size={14} />Select a source to inspect its context.</p>
          </div>
          <div className="ur-convergence" aria-hidden="true"><svg viewBox="0 0 100 400" preserveAspectRatio="none"><path d="M0 46H22Q50 46 50 82V168Q50 200 100 200" /><path d="M0 124H24Q50 124 50 150V178Q50 200 100 200" /><path d="M0 202H100" /><path d="M0 280H24Q50 280 50 254V222Q50 200 100 200" /><path d="M0 358H22Q50 358 50 324V232Q50 200 100 200" /><path className="ur-flow" d="M0 46H22Q50 46 50 82V168Q50 200 100 200" /><path className="ur-flow ur-flow-second" d="M0 358H22Q50 358 50 324V232Q50 200 100 200" /></svg><span className="ur-connection-node" /></div>
          <div className="ur-record-column">
            {connected ? <div ref={record} tabIndex={-1} className="ur-record" aria-label="Connected illustrative shipment record"><div className="ur-record-header"><div><span className="ur-record-kicker">PACKPROOF / ORDER #1042</span><h3>One shipment.<br />A clearer place to start.</h3></div><img src="/brand/packproof-symbol-reversed.svg" alt="" width={36} height={36} /></div><div className="ur-review-flags"><Glyph name="alert" size={17} /><span><strong>2 items need a closer look</strong>Gaps and differences stay visible.</span></div><ol className="ur-chronology">{reviewSources.map(source => <li className={selected === source.id ? "ur-current-event" : ""} key={source.id}><span className="ur-event-time">{source.time}</span><span className={source.flag ? "ur-event-node ur-event-flag" : "ur-event-node"} /><div><strong>{source.event}</strong><span>{source.name}</span>{source.flag && <small>{source.flag}</small>}</div></li>)}</ol><div className="ur-record-footer"><Glyph name="link" size={15} /><span>Original sources stay attributable.</span></div></div> : <div className="ur-unassembled"><div className="ur-loose-grid" aria-hidden="true" /><span className="ur-unassembled-label">BEFORE THE REVIEW</span><h3>The pieces exist.<br />The context takes work.</h3><p>A file in one system.<br />A reference in another.<br />A question between them.</p><div className="ur-loose-files" aria-hidden="true"><span><Glyph name="file" size={18} />order-1042.json</span><span><Glyph name="film" size={18} />packing-1042.mp4</span><span><Glyph name="activity" size={18} />dispatch-batch.csv</span></div><button type="button" className="ur-connect-action" onClick={assemble}>Bring the record together <Glyph size={18} /></button></div>}
          </div>
        </div>
        <div className="ur-inspector" id={inspectorId} aria-live="polite" aria-atomic="true">
          <div className="ur-inspector-origin"><span className="ur-inspector-icon"><Glyph name={active.icon} size={22} /></span><div><span>SOURCE IN FOCUS</span><h3>{active.name}</h3><code>{active.file}</code></div></div>
          <div className="ur-inspector-observation"><span className={active.flag ? "ur-inspector-tag ur-inspector-flag" : "ur-inspector-tag"}>{active.flag || "SOURCE CONTEXT"}</span><p>{active.observation}</p><small>{active.limitation}</small></div>
        </div>
        <div className="ur-stage-note"><span className="ur-demo-dot" /><p>Interactive workflow illustration. All records and exceptions above are fictional. Source connections and import scope are agreed for each supported pilot.</p></div>
        <span className="ur-screen-reader" role="status">{connected ? "Connected view. Five attributed sources form one chronology, with two review exceptions." : "Scattered view. Five separate sources are available to inspect."}</span>
      </div>
      <div className="ur-pilot" data-reveal><div className="ur-pilot-number" aria-hidden="true">01<br /><span>PILOT</span></div><div><p className="ur-eyebrow">START WITH THE RECORDS YOU ALREADY HAVE</p><h3>Show the value on a real review.</h3><p>By arrangement, begin with historical shipment evidence. Keep your existing systems, agree the supported inputs, and measure review time and unresolved gaps against your current process.</p></div><a href="mailto:admin@thepackproof.com?subject=PackProof%20historical%20shipment%20pilot">Discuss a pilot <Glyph size={18} /></a></div>
    </div>
  </section>;
}
