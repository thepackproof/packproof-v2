import { useId, useRef, useState, type KeyboardEvent } from "react";
import { EvidencePreview } from "../components/EvidencePreview";
import { ProofTimeline } from "../components/ProofTimeline";
import { ShipmentTracking } from "../components/ShipmentTracking";
import { sampleChronology, sampleTracking } from "./sampleData";
import { downloadBlob } from "../components/SignatureWorkbench";

const chapters = [{ at: 0, label: "Open box" }, { at: 4, label: "Packing material" }, { at: 14, label: "Mug shown" }, { at: 18, label: "Mug placed inside" }];
const samplePacket = { kind: "ILLUSTRATIVE_SAMPLE_ONLY", title: "Reported missing contents · sample review", order: { reference: "1042", item: "Ceramic mug", quantity: 1, source: "FICTIONAL_ORDER" }, footage: { source: "LICENSED_STOCK_FOOTAGE_NOT_PACKPROOF_CAPTURE", path: "/sample-packing.mp4", chapters }, gaps: ["No final seal, shipping label, serial number or carrier handoff is visible.", "The clip does not establish the contents of a delivered shipment.", "All order and carrier details are fictional."], decision: "No authenticity, liability, fraud or refund determination." };
import "./sample-proof.css";

type SampleTab = "Recording" | "Activity" | "Tracking";
type SampleTool = "receipt" | "case" | null;
const recordTabs: SampleTab[] = ["Recording", "Activity", "Tracking"];

export function SampleProof({ compact = false }: { compact?: boolean }) {
  const [tab, setTab] = useState<SampleTab>("Recording");
  const [tool, setTool] = useState<SampleTool>(() => {
    const view = new URLSearchParams(location.search).get("view");
    return view === "receipt" || view === "case" ? view : null;
  });
  const [approved, setApproved] = useState(false), [notice, setNotice] = useState("");
  const player = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLDetailsElement>(null);
  const id = useId();
  function pauseRecording() {
    const video = player.current?.querySelector("video");
    if (video && !video.paused) video.pause();
  }
  function selectTab(next: SampleTab) {
    if (next !== "Recording") pauseRecording();
    setTab(next); setTool(null); setNotice("");
  }
  function openTool(next: SampleTool) {
    pauseRecording(); setTool(next); setNotice("");
    if (more.current) more.current.open = false;
  }
  function jump(at: number) {
    selectTab("Recording");
    // The original player stays mounted while another section is open.
    requestAnimationFrame(() => { const video = player.current?.querySelector("video"); if (video) { video.currentTime = at; video.focus(); } });
  }
  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, current: SampleTab) {
    const index = recordTabs.indexOf(current);
    const next = event.key === "ArrowRight" ? recordTabs[(index + 1) % recordTabs.length]
      : event.key === "ArrowLeft" ? recordTabs[(index + recordTabs.length - 1) % recordTabs.length]
      : event.key === "Home" ? recordTabs[0] : event.key === "End" ? recordTabs[recordTabs.length - 1] : null;
    if (next) { event.preventDefault(); selectTab(next); document.getElementById(`${id}-${next}-tab`)?.focus(); }
  }
  return <article className={`sample-record sample-canonical ${compact ? "" : "sample-large"}`}>
    <div className="sample-top"><div><strong>Ceramic mug · Order #1042</strong><span>Fictional Proof · sample only</span></div><span className="sample-label">SAMPLE</span>
      <details ref={more} className="sample-more"><summary>More</summary><div>
        <button type="button" onClick={() => openTool("receipt")}>Receipt and returns</button>
        <button type="button" onClick={() => openTool("case")}>Evidence and claim tools</button>
      </div></details>
    </div>
    <div className="sample-tabs" role="tablist" aria-label="Sample record views">{recordTabs.map(t => <button key={t} id={`${id}-${t}-tab`} type="button" role="tab" aria-selected={tab === t} aria-controls={`${id}-${t}-panel`} tabIndex={tab === t ? 0 : -1} onKeyDown={event => navigateTabs(event, t)} onClick={() => selectTab(t)}>{t}</button>)}</div>
    <div className="sample-body">
      <section role="tabpanel" id={`${id}-Recording-panel`} aria-labelledby={`${id}-Recording-tab`} hidden={tab !== "Recording" || tool !== null}>
        <div ref={player}><EvidencePreview url="/sample-packing.mp4" contentType="video/mp4" evidenceId="illustrative-stock" title="Packing a ceramic mug" provenanceLabel="Illustrative stock footage · not a PackProof capture"/></div>
        <div className="sample-chapters" aria-label="Source moments">{chapters.map(c => <button key={c.at} onClick={() => jump(c.at)}>{`0:${String(c.at).padStart(2, "0")}`} · {c.label}</button>)}</div><p className="note">These sample bookmarks point to visible moments in the clip. No seal, label, serial number or carrier handoff is shown.</p>
      </section>
      {tab === "Activity" && !tool && <section role="tabpanel" id={`${id}-Activity-panel`} aria-labelledby={`${id}-Activity-tab`}><ProofTimeline entries={sampleChronology} finalizedAt="2026-09-01T09:46:00Z"/></section>}
      {tab === "Tracking" && !tool && <section role="tabpanel" id={`${id}-Tracking-panel`} aria-labelledby={`${id}-Tracking-tab`}><ShipmentTracking demo events={sampleTracking} carrier="Example carrier" trackingNumber="DEMO-1042"/></section>}
      {tool && <button className="text-link sample-back" type="button" onClick={() => selectTab(tab)}>Back to {tab.toLowerCase()}</button>}
      {tool === "receipt" && <section className="stack" aria-label="Sample receipt and returns"><p className="panel-eyebrow">BUYER RECEIPT · SAMPLE</p><h3>Your shipment record</h3><p>A seller can share selected order details and reviewed media in a read-only receipt.</p><dl><dt>Order</dt><dd>One ceramic mug · fictional order #1042</dd><dt>Example carrier report</dt><dd>In transit · illustrative data</dd><dt>Buyer acknowledgment</dt><dd>Not recorded</dd></dl><button className="btn btn-secondary" onClick={() => selectTab("Recording")}>Review the recording</button><button className="btn btn-secondary" onClick={() => setNotice("In a real receipt, the invited buyer signs in before adding their own recording. This sample does not create an acknowledgment.")}>See how receipt recording works</button><p className="note">Viewing a receipt does not acknowledge delivery, accept an item’s condition, or waive a return.</p></section>}
      {tool === "case" && <section className="stack" aria-label="Sample evidence and claim tools"><p className="panel-eyebrow">EXACT SAMPLE PACKET PREVIEW</p><h3>{samplePacket.title}</h3><p>Fictional order: one ceramic mug. The illustrative clip shows packing material, the mug, and placement into a box.</p><h4>Source index</h4>{chapters.map(c => <button className="text-link" key={c.at} onClick={() => jump(c.at)}>{c.label} · 0:{String(c.at).padStart(2,"0")}</button>)}<h4>Gaps</h4><ul>{samplePacket.gaps.map(g => <li key={g}>{g}</li>)}</ul><p>{samplePacket.decision}</p><details><summary>Complete export contents</summary><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{JSON.stringify(samplePacket,null,2)}</pre></details><label><input type="checkbox" checked={approved} onChange={e=>setApproved(e.target.checked)}/> I reviewed this fictional sample packet</label><button className="btn" disabled={!approved} onClick={() => downloadBlob(new Blob([JSON.stringify(samplePacket,null,2)],{type:"application/json"}),"packproof-illustrative-case.json")}>Download sample packet</button><p className="note">Nothing is sent to a carrier or marketplace.</p></section>}
      {notice && <p role="status">{notice}</p>}
    </div><div className="sample-source-note">Illustrative stock footage with fictional order details. This clip was not recorded through PackProof and does not depict a PackProof customer shipment. <a href="https://www.pexels.com/video/close-up-of-a-person-packing-a-ceramic-product-7667415/" target="_blank" rel="noreferrer">MART PRODUCTION / Pexels</a> · <a href="https://www.pexels.com/license/" target="_blank" rel="noreferrer">License</a></div>
  </article>;
}
