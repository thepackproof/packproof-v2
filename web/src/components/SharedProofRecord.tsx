import { useRef, useState } from "react";
import { recordProofStatus } from "@packproof/copy/proof-record";
import type { PublicProofView } from "../api/types";
import { formatWhen } from "../format";
import { PublicMedia } from "./PublicMedia";
import { StatusBadge } from "./StatusBadge";

export type SharedProofView = PublicProofView & {
  tracker?: {
    itemTitle: string | null;
    reference?: string | null;
    headline: string;
    shipment?: { carrier: string | null; service: string | null; trackingNumber: string | null } | null;
    milestones: Array<{ code: string; label: string; occurredAt: string | null; state?: string }>;
  };
};
const tabs = ["Recording", "Activity", "Tracking"] as const;

/** Every sharing destination uses this same record and the server's authorized sources. */
export function SharedProofRecord({ proof, loadMedia }: {
  proof: SharedProofView;
  loadMedia?: (id: string) => Promise<Blob>;
}) {
  const [tab, setTab] = useState<typeof tabs[number]>("Recording");
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const tracker = proof.tracker;
  const milestones = tracker?.milestones.filter(item => Boolean(item.occurredAt)) ?? [];
  const shipmentCodes = new Set(["CARRIER_ACCEPTED", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "CARRIER_REPORTED_DELIVERY"]);
  const shipments = milestones.filter(item => shipmentCodes.has(item.code));
  const activity = milestones.length ? milestones : (proof.observations ?? []).map((item, index) => ({ code: String(index), ...item }));
  const [selected, setSelected] = useState<string | null>(null);
  const current = proof.evidence?.find(item => item.evidenceId === selected) ?? proof.evidence?.[0];
  return <article className="workspace-proof-record" aria-label="Proof record">
    <header className="record-top">
      <div><h2>{tracker?.itemTitle || "Shared Proof"}</h2>{tracker?.reference && <p>{tracker.reference}</p>}</div>
      <StatusBadge label={recordProofStatus(proof.status)} />
    </header>
    {proof.recordAsOf && <p className="record-source-note">{proof.recordAsOf.scopeStatement} Record update {proof.recordAsOf.supplementSequence}.</p>}
    <div className="record-tabs" role="tablist" aria-label="Proof record views">
      {tabs.map((name, index) => <button key={name} type="button" role="tab" ref={element => { buttons.current[index] = element; }}
        id={`shared-${proof.proofId}-${name}-tab`} aria-controls={`shared-${proof.proofId}-${name}-panel`}
        aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)}
        onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
          if (next !== null) { event.preventDefault(); setTab(tabs[next]); buttons.current[next]?.focus(); }
        }}>{name}</button>)}
    </div>
    <div className="record-body" role="tabpanel" tabIndex={0} id={`shared-${proof.proofId}-${tab}-panel`} aria-labelledby={`shared-${proof.proofId}-${tab}-tab`}>
      {tab === "Recording" && <div className="stack">
        {current && loadMedia ? <PublicMedia key={`${current.evidenceId}:${current.derivativeId || "original"}`} media={current} load={loadMedia} autoOpen /> : <p className="note">{current ? "Recording playback is unavailable." : "No recording is available through this link."}</p>}
        {(proof.evidence?.length ?? 0) > 1 && <div className="evidence-file-tabs" aria-label="Recordings">{proof.evidence!.map((item, index) => <button key={item.evidenceId} aria-pressed={current?.evidenceId === item.evidenceId} onClick={() => setSelected(item.evidenceId)}>{item.slot || "Recording"} {index + 1}</button>)}</div>}
        {proof.statements?.filter(statement=>!statement.relatedEvidenceId||statement.relatedEvidenceId===current?.evidenceId).map(statement=><section key={statement.attestationId} aria-label="Participant statement">
          <h3>{statement.attributedTo}</h3><p>{statement.statement}</p>
          <p className="note">Recorded {formatWhen(statement.createdAt)}. {statement.signatureVerification==='SERVER_VERIFIED'?'Declaration signature verified.':'Participant statement recorded.'}</p>
          {statement.biometricPolicy && <details><summary>Confirmation details</summary><p>{statement.biometricPolicy} This does not verify legal identity, package contents or hardware origin.</p></details>}
        </section>)}
      </div>}
      {tab === "Activity" && (activity.length ? <ol className="shared-proof-activity">{activity.map(item => <li key={item.code}><strong>{item.label}</strong><time dateTime={item.occurredAt!}>{formatWhen(item.occurredAt)}</time></li>)}</ol> : <p className="note">No activity recorded yet.</p>)}
      {tab === "Tracking" && <div className="stack">
        <h3>{tracker?.shipment?.carrier || "Shipment tracking"}</h3>
        {tracker?.shipment?.trackingNumber && <p className="tracking-number">{tracker.shipment.trackingNumber}</p>}
        {shipments.length ? <ol className="shared-proof-activity">{shipments.map(item => <li key={item.code}><strong>{item.label}</strong><time dateTime={item.occurredAt!}>{formatWhen(item.occurredAt)}</time></li>)}</ol> : <p className="note">Waiting for the first carrier update.</p>}
      </div>}
    </div>
  </article>;
}
