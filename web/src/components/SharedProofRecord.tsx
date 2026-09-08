import { useRef } from "react";
import { recordProofStatus } from "@packproof/copy/proof-record";
import type { ChronologyEntry, PublicProofView } from "../api/types";
import { formatWhen } from "../format";
import { useViewState } from "../navigation-context";
import { PublicMedia } from "./PublicMedia";
import { ProofTimeline } from "./ProofTimeline";
import { StatusBadge } from "./StatusBadge";

export type SharedProofView = PublicProofView & {
  // These optional projections contain only fields the server authorized for this link.
  chronology?: ChronologyEntry[];
  recordTracking?: {
    carrier: string | null;
    status: string | null;
    lastUpdatedAt: string | null;
    source: string;
    syncState: "NO_LABEL" | "AWAITING_CARRIER_SCAN" | "SYNC_PENDING" | "SYNC_DELAYED" | "SERVICE_UNAVAILABLE" | "UP_TO_DATE" | string;
    events: Array<{ id: string; eventType: string; occurredAt: string; source: string; provider: string }>;
  };
  tracker?: {
    itemTitle: string | null;
    reference?: string | null;
    headline: string;
    lastUpdatedAt?: string | null;
    shipment?: { carrier: string | null; service: string | null; trackingNumber: string | null } | null;
    milestones: Array<{ code: string; label: string; occurredAt: string | null; state?: string }>;
  };
};
const tabs = ["Recording", "Activity", "Tracking"] as const;
type RecordTab = typeof tabs[number];

/** Uses only the server's authorized projection of the same canonical record. */
export function SharedProofRecord({ proof, loadMedia }: {
  proof: SharedProofView;
  loadMedia?: (id: string) => Promise<Blob>;
}) {
  const scope = `${proof.proofId}.${proof.disclosure?.viewHash || proof.scope}`;
  const [savedTab, setTab] = useViewState<RecordTab>(`shared.${scope}.tab`, "Recording");
  const tab = tabs.includes(savedTab) ? savedTab : "Recording";
  const record = useRef<HTMLElement>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const tracker = proof.tracker;
  const milestones = tracker?.milestones.filter(item => Boolean(item.occurredAt)) ?? [];
  const shipmentCodes = new Set(["CARRIER_ACCEPTED", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "CARRIER_REPORTED_DELIVERY"]);
  const shipments = milestones.filter(item => shipmentCodes.has(item.code));
  const activity = milestones.length ? milestones : (proof.observations ?? []).map((item, index) => ({ code: String(index), ...item }));
  const [selected, setSelected] = useViewState<string | null>(`shared.${scope}.evidence`, null);
  const current = proof.evidence?.find(item => item.evidenceId === selected) ?? proof.evidence?.[0];
  function select(next: RecordTab, focus = false) {
    if (next !== "Recording") record.current?.querySelectorAll<HTMLMediaElement>("video,audio").forEach(media => media.pause());
    setTab(next);
    if (focus) buttons.current[tabs.indexOf(next)]?.focus();
  }
  return <article ref={record} className="workspace-proof-record" aria-label="Proof record">
    <header className="record-top">
      <div><h2>{tracker?.itemTitle || "Shared Proof"}</h2>{tracker?.reference && <p>{tracker.reference}</p>}</div>
      <StatusBadge label={recordProofStatus(proof.status)} />
    </header>
    {proof.recordAsOf && <p className="record-source-note">{proof.recordAsOf.scopeStatement}</p>}
    <div className="record-tabs" role="tablist" aria-label="Proof record views">
      {tabs.map((name, index) => <button key={name} type="button" role="tab" ref={element => { buttons.current[index] = element; }}
        id={`shared-${proof.proofId}-${name}-tab`} aria-controls={`shared-${proof.proofId}-${name}-panel`}
        aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} onClick={() => select(name)}
        onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
          if (next !== null) { event.preventDefault(); select(tabs[next], true); }
        }}>{name}</button>)}
    </div>
    <div className="record-body" hidden={tab !== "Recording"} role="tabpanel" tabIndex={0} id={`shared-${proof.proofId}-Recording-panel`} aria-labelledby={`shared-${proof.proofId}-Recording-tab`}>
      <div className="stack">
        {current && loadMedia ? <PublicMedia key={`${current.evidenceId}:${current.derivativeId || "original"}`} playbackScope={scope} media={current} load={loadMedia} autoOpen /> : <p className="note">{current ? "Recording playback is unavailable." : "No recording is available through this link."}</p>}
        {(proof.evidence?.length ?? 0) > 1 && <div className="evidence-file-tabs" aria-label="Recordings">{proof.evidence!.map((item, index) => <button key={item.evidenceId} aria-pressed={current?.evidenceId === item.evidenceId} onClick={() => setSelected(item.evidenceId)}>{item.slot || "Recording"} {index + 1}</button>)}</div>}
        {proof.statements?.filter(statement=>!statement.relatedEvidenceId||statement.relatedEvidenceId===current?.evidenceId).map(statement=><section className="record-declaration" key={statement.attestationId} aria-label="Participant statement">
          <h3>{statement.attributedTo}</h3><p>{statement.statement}</p>
          <p className="note">Recorded {formatWhen(statement.createdAt)}. {statement.signatureVerification==='SERVER_VERIFIED'?'Declaration signature verified.':'Participant statement recorded.'}</p>
          {statement.biometricPolicy && <details><summary>Confirmation details</summary><p>{statement.biometricPolicy} This does not verify legal identity, package contents or hardware origin.</p></details>}
        </section>)}
      </div>
    </div>
    <div className="record-body" hidden={tab !== "Activity"} role="tabpanel" tabIndex={0} id={`shared-${proof.proofId}-Activity-panel`} aria-labelledby={`shared-${proof.proofId}-Activity-tab`}>
      {tab === "Activity" && (proof.chronology ? <ProofTimeline entries={proof.chronology} /> : activity.length ? <><ol className="shared-proof-activity">{activity.map((item, index) => <li key={`${item.code}.${item.occurredAt}.${index}`}><strong>{item.label}</strong><time dateTime={item.occurredAt!}>{formatWhen(item.occurredAt)}</time></li>)}</ol><p className="note">Recorded milestones included in this link. Exact source details appear when included by the server.</p></> : <p className="note">No activity is included in this view yet.</p>)}
    </div>
    <div className="record-body" hidden={tab !== "Tracking"} role="tabpanel" tabIndex={0} id={`shared-${proof.proofId}-Tracking-panel`} aria-labelledby={`shared-${proof.proofId}-Tracking-tab`}>
      {tab === "Tracking" && (proof.recordTracking ? <SharedTracking tracking={proof.recordTracking} /> : <div className="stack">
        <h3>{tracker?.shipment?.carrier || "Shipment tracking"}</h3>
        {tracker?.shipment?.trackingNumber && <p className="tracking-number">{tracker.shipment.trackingNumber}</p>}
        {shipments.length ? <><ol className="shared-proof-activity">{shipments.map((item, index) => <li key={`${item.code}.${item.occurredAt}.${index}`}><strong>{item.label}</strong><time dateTime={item.occurredAt!}>{formatWhen(item.occurredAt)}</time></li>)}</ol><p className="note">Carrier reports included in this link. These reports do not change the locked packing record.</p></> : <p className="note">{proof.disclosure && !proof.disclosure.fields.includes("shipping") ? "Tracking details aren’t included in this link." : "No carrier reports are included in this view yet."}</p>}
      </div>)}
    </div>
  </article>;
}

function SharedTracking({ tracking }: { tracking: NonNullable<SharedProofView["recordTracking"]> }) {
  const statusLabels: Record<string, string> = {
    NO_LABEL: "No tracking number is attached to this Proof. The recording remains available.",
    AWAITING_CARRIER_SCAN: "Tracking number recorded. No carrier scan has been reported yet.",
    SYNC_PENDING: "Tracking updates are still being checked.",
    SYNC_DELAYED: "Tracking updates are delayed. Previously recorded reports remain available.",
    SERVICE_UNAVAILABLE: "Carrier updates are temporarily unavailable. Previously recorded reports remain available.",
  };
  const events = [...tracking.events].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.id.localeCompare(b.id));
  const label = (value: string) => value.toLowerCase().replaceAll("_", " ").replace(/^\w/, letter => letter.toUpperCase());
  return <div className="stack">
    <h3>{tracking.carrier || "Shipment tracking"}</h3>
    {tracking.status && <p className="card-title">{label(tracking.status)}</p>}
    {statusLabels[tracking.syncState] && <p className="note" role="status">{statusLabels[tracking.syncState]}</p>}
    {tracking.lastUpdatedAt && <p className="note">Last recorded update: <time dateTime={tracking.lastUpdatedAt}>{formatWhen(tracking.lastUpdatedAt)}</time></p>}
    {events.length ? <ol className="shared-proof-activity">{events.map(event => <li key={event.id}><strong>{label(event.eventType)}</strong><time dateTime={event.occurredAt}>{formatWhen(event.occurredAt)}</time><span className="meta">{[event.provider, event.source].filter(Boolean).join(" · ")}</span></li>)}</ol> : !statusLabels[tracking.syncState] ? <p className="note">No carrier reports are included in this view yet.</p> : null}
    <p className="note">Carrier reports are separate from the locked packing record.</p>
  </div>;
}
