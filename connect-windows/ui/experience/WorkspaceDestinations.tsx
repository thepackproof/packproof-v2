import { useEffect, useMemo, useState } from "react";
import type { ConnectStatus } from "../types";
import type { AttentionReport, OrderDetail, OrderSummary } from "../workspace-types";
import type { RunAction, WorkspaceProps } from "./WorkspaceModel";
import { sourceTitle, sourceIssue } from "./WorkspaceModel";
import { modelProof } from "./ProofModel";
import { Icon } from "./Icon";
import { useEvidencePreferences } from "./Shell";
import "./WorkspaceDestinations.css";

type Base = {
  status: ConnectStatus;
  bridge: WorkspaceProps["bridge"];
  busy: boolean;
  run: RunAction;
  onSection: WorkspaceProps["onSection"];
  onProof: WorkspaceProps["onProof"];
  onOutputSetup: () => void;
};
type MatchingProps = Base & {
  report: AttentionReport | null;
  error: string;
  onRefresh: () => void;
};
const available = (status: ConnectStatus) =>
  status.health.serviceOnline &&
  status.workspace?.canReadOrders !== false &&
  !["unreachable", "unauthenticated", "forbidden"].includes(status.transport?.state || "");

const header = (eyebrow: string, title: string, sub: string) => (
  <header className="eo-route-heading">
    <span className="eo-route-eyebrow">{eyebrow}</span>
    <h1>{title}</h1>
    <p>{sub}</p>
  </header>
);

function Restricted({ onSection }: Pick<Base, "onSection">) {
  return (
    <div className="eo-route-empty" role="status">
      <Icon name="attention" size={32} />
      <div>
        <strong>Current facility records aren't available.</strong>
        <p>Restore your approved connection to inspect orders and source evidence.</p>
      </div>
      <button className="eo-route-action" onClick={() => onSection("connections")}>Check connections</button>
    </div>
  );
}

/**
 * Figma 4:230 — Explainable record linking.
 * Only server-observed unresolved links are shown; the client never invents
 * match confidence or silently associates two records.
 */
export function MatchingWorkspace({ status, bridge, report, error, busy, run, onSection, onProof, onRefresh }: MatchingProps) {
  const ws = status.workspace!;
  const matched = (report?.items ?? []).filter((row) => row.proofId && row.revision);
  const unresolved = (report?.items ?? []).filter((row) => !row.proofId || !row.revision);
  return (
    <section className="eo-route" data-design-file="nNnkgTZOBNkG8muy8AkIv1" data-design-node="4:230">
      {header("MATCH INTELLIGENCE", "Records that belong together.",
        "See the actual source relationships and investigate uncertain matches without guessing.")}
      {!available(status) ? <Restricted onSection={onSection} /> : <>
        <div className="eo-route-grid eo-route-grid-wide">
          <article className="eo-route-panel eo-match-principles">
            <div className="eo-route-panel-title">
              <h2>What PackProof connects</h2><span className="eo-route-tag">DETERMINISTIC MATCHING</span>
            </div>
            <div className="eo-match-chain" aria-label="Order, carton and carrier evidence">
              {[
                ["Order", "ERP / order reference", "records"],
                ["Carton", "Pack station / scan identifiers", "packing"],
                ["Shipment", "Carrier / tracking relationship", "shipping"],
              ].map(([title, description, symbol], i) => (
                <div className="eo-match-stage" key={title}>
                  <Icon name={symbol} size={27} />
                  <strong>{title}</strong>
                  <small>{description}</small>
                  {i < 2 && <span className="eo-match-link" aria-hidden="true" />}
                </div>
              ))}
            </div>
            <div className="eo-match-rule">
              <Icon name="records" size={27} />
              <div><strong>Every association must be explainable.</strong>
                <p>Source identifiers, relationships and provenance stay available in each order's Proof.</p>
              </div>
            </div>
          </article>
          <article className="eo-route-panel eo-match-safety">
            <Icon name="attention" size={34} />
            <h2>When the records don't agree</h2>
            <p>Evidence remains unmatched until an authorized reviewer confirms the correct relationship. Similar dates or descriptions are not proof of identity.</p>
            <button className="eo-route-action" disabled={busy} onClick={() => void run(() => bridge.openWorkspaceReview())}>Review unmatched records</button>
          </article>
        </div>
        <div className="eo-route-panel eo-route-followup">
          <div className="eo-route-panel-title">
            <div><h2>Current matching decisions</h2>
              <p>Unresolved observations from your approved facility, not simulated examples.</p></div>
            <button className="eo-route-quiet" disabled={busy} onClick={onRefresh}>Refresh review</button>
          </div>
          {error && <p className="eo-route-warning" role="alert">{error}</p>}
          {!report ? <p role="status" className="eo-route-emptyline">Checking current source relationships…</p> :
            report.items.length ? (
              <div className="eo-route-lines">
                {report.items.slice(0, 12).map((row, index) => {
                  const source = ws.sources.find((s) => s.id === row.sourceId);
                  const linked = !!row.proofId && !!row.revision;
                  const label = row.fileName || row.orderReference || "Source observation";
                  return (
                    <button key={JSON.stringify([row.sourceId,row.proofId,row.revision,row.locator,index])} className="eo-route-line"
                      disabled={busy}
                      onClick={() => linked ? onProof(row.proofId!, row.revision!) : void run(() => bridge.openWorkspaceReview())}>
                      <span className={"eo-route-statusdot " + (linked ? "is-linked" : "is-unmatched")}/>
                      <span><strong>{label}</strong>
                        <small>{[source ? sourceTitle(source) : "Source",row.reason,row.locator].filter(Boolean).join(" · ")}</small></span>
                      <span className="eo-route-outcome">{linked ? "View linked Proof" : "Review relationship"}</span>
                    </button>
                  );
                })}
              </div>
            ) : <p className="eo-route-emptyline">No unresolved relationships were returned in the current review.</p>}
          {report?.hasMore && <p className="eo-route-context">Additional records are available in the authenticated online review.</p>}
          {report && <p className="eo-route-context">Current results: {unresolved.length} unmatched and {matched.length} linked review item(s). These are review observations, not a warehouse-wide matching accuracy score.</p>}
        </div>
      </>}
    </section>
  );
}

/**
 * Figma 5:190 — Source manifest is read from an actual authorized Proof
 * revision. Hashes are informational; Figma's fake "0 failures" is never shown.
 */
export function IntegrityWorkspace({ status, bridge, onSection, onProof }: Base) {
  const ws = status.workspace!;
  const orders = ws.orders ?? [];
  const [selected, setSelected] = useState<OrderSummary | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [failure, setFailure] = useState("");
  const [loading, setLoading] = useState(false);
  const scope = JSON.stringify([status.installationId, ws.viewKey, ws.canReadOrders, status.binding?.organizationId]);
  const chosen = selected && orders.find((o) => o.proofId === selected.proofId);
  // Do not let a previously authorized revision survive a facility switch or a
  // newer observed revision. Every inspection rechecks its exact identity.
  const effective = chosen?.revision === selected?.revision ? selected : null;
  useEffect(() => {
    setSelected(null); setDetail(null); setFailure("");
  }, [scope]);
  useEffect(() => {
    if (!effective || !available(status)) { setDetail(null); return; }
    let live = true;
    setDetail(null); setFailure(""); setLoading(true);
    void bridge.workspaceOrderDetail(effective.proofId,effective.revision)
      .then((result) => {
        if (!live) return;
        if (result.proofId !== effective.proofId || result.revision !== effective.revision)
          throw new Error("The Proof revision changed. Select the current order again.");
        setDetail(result);
      })
      .catch((error) => { if (live) setFailure(error instanceof Error ? error.message : "Could not load this Proof revision."); })
      .finally(() => { if (live) setLoading(false); });
    return () => {live=false;};
  }, [bridge, effective?.proofId, effective?.revision, scope, status.health.serviceOnline, ws.canReadOrders]);
  const proof = useMemo(() => detail ? modelProof(detail) : null, [detail]);
  return (
    <section className="eo-route" data-design-file="nNnkgTZOBNkG8muy8AkIv1" data-design-node="5:190">
      {header("EVIDENCE INTEGRITY", "Trust you can inspect.",
        "Inspect the source lineage and preserved digests of one authorized order at a time.")}
      {!available(status) ? <Restricted onSection={onSection} /> :
      <div className="eo-route-grid eo-route-grid-integrity">
        <article className="eo-route-panel">
          <div className="eo-route-panel-title"><h2>Choose a Proof</h2><span className="eo-route-tag">{orders.length} VISIBLE ORDERS</span></div>
          {orders.length ? orders.slice(0, 20).map((order) => (
            <button key={order.proofId} className="eo-route-line" aria-pressed={effective?.proofId === order.proofId}
              onClick={() => setSelected(order)}>
              <span className="eo-route-statusdot is-linked"/><span><strong>{order.orderReference}</strong>
              <small>{order.customerName || "Customer not reported"} · Revision {order.revision}</small></span>
              <span className="eo-route-outcome">{order.issue ? "Needs review" : "Inspect"}</span>
            </button>
          )) : <p className="eo-route-emptyline">No orders are available in the current authorized page.</p>}
          {ws.nextBefore && <button className="eo-route-quiet" onClick={() => onSection("orders")}>Find earlier orders</button>}
        </article>
        <article className="eo-route-panel eo-integrity-manifest">
          {!effective ? <>
            <Icon name="records" size={38}/>
            <h2>Inspect an order's evidence</h2>
            <p>Select a Proof to see source file names, recorded hashes and the revision observed by PackProof.</p>
          </> : loading ? <p role="status" className="eo-route-emptyline">Reading the authorized Proof revision…</p> :
            failure ? <p role="alert" className="eo-route-warning">{failure}</p> :
            detail && proof ? <>
              <div className="eo-route-panel-title">
                <div><h2>{detail.orderReference}</h2><p>Revision {detail.revision} · {proof.sources.length} source entries</p></div>
                <span className="eo-route-tag">SERVER RECORD</span>
              </div>
              <p className="eo-route-context">Integrity reported by server: {detail.integrity || "Not reported"}. Displayed hashes are recorded values, not an independent client re-verification.</p>
              <div className="eo-route-lines">
                {proof.sources.slice(0, 9).map((source) => (
                  <div className="eo-route-line eo-route-static" key={source.key}>
                    <Icon name="records" size={24}/>
                    <span><strong>{source.fileName || source.title}</strong><small>{source.origin} · {source.received || "Arrival time not reported"}</small></span>
                    <span className="eo-route-outcome">{source.hash ? "SHA-256: " + source.hash.slice(0, 10) + "…" : "Digest unavailable"}</span>
                  </div>
                ))}
              </div>
              {proof.sources.length > 9 && <p className="eo-route-context">Showing 9 source entries. Open the Proof to inspect the complete history.</p>}
              <button className="eo-route-action" onClick={() => onProof(detail.proofId,detail.revision)}>Open evidence and history</button>
            </> : <p className="eo-route-emptyline">No source records available for the selected revision.</p>}
        </article>
      </div>}
    </section>
  );
}

export function ExportsWorkspace({status, bridge, run, busy, onSection, onOutputSetup}: Base) {
  const output = status.proofOutput;
  const workspace = status.workspace!;
  const folder = output?.folder || workspace.outputFolder;
  const state = output?.state || "not_configured";
  const issue = ["access_denied", "unavailable", "pending"].includes(state);
  return (
    <section className="eo-route" data-design-file="nNnkgTZOBNkG8muy8AkIv1" data-design-node="5:286">
      {header("PROOF OUTPUT", "The proof goes where your team needs it.",
        "Local Proof copies are published by the existing collector after the backend accepts each revision.")}
      <div className="eo-route-destinations">
        <article className="eo-route-panel eo-destination">
          <Icon name="folder" size={34}/>
          <h2>Local Proof archive</h2>
          <p>{folder || "No folder selected"}</p>
          <span className={"eo-route-tag " + (issue ? "is-warning" : "")}>{state.replaceAll("_"," ").toUpperCase()}</span>
        </article>
        <article className="eo-route-panel eo-destination">
          <Icon name="records" size={34}/>
          <h2>Online Proof</h2>
          <p>Open authorized order records in the PackProof portal.</p>
          <span className="eo-route-tag">{workspace.canReadOrders === false ? "ACCESS REQUIRED" : "AUTHENTICATED ACCESS"}</span>
        </article>
        <article className="eo-route-panel eo-destination">
          <Icon name="connection" size={34}/>
          <h2>Source permissions</h2>
          <p>Output and collection folders have different access boundaries.</p>
          <span className="eo-route-tag">EXPLICIT APPROVAL</span>
        </article>
      </div>
      <div className="eo-route-grid eo-route-grid-wide">
        <article className="eo-route-panel eo-output-state">
          <div className="eo-route-panel-title"><h2>Local output status</h2><span className="eo-route-tag">{output?.pending ?? 0} PENDING</span></div>
          <div className="eo-output-stat"><strong>{output?.completedRevision ?? "—"}</strong><span>Last locally completed revision reported</span></div>
          <div className="eo-output-stat"><strong>{output?.pending ?? "—"}</strong><span>Outstanding local copies</span></div>
          {issue && <p className="eo-route-warning">The output folder needs attention or has pending work. Previously completed originals and proofs must remain preserved.</p>}
          <div className="eo-route-buttons">
            <button className="eo-route-action" disabled={busy} onClick={onOutputSetup}>Change Proof folder</button>
            <button className="eo-route-subaction" disabled={busy || !folder} onClick={() => void run(() => bridge.openWorkspaceOutput())}>Open local archive</button>
          </div>
        </article>
        <article className="eo-route-panel eo-output-state">
          <h2>Versioning & recovery</h2>
          <ul className="eo-route-checks">
            <li>Existing accepted revisions retain their source identities.</li>
            <li>Late evidence is appended as a new revision, never a silent replacement.</li>
            <li>Output publication and current backend status are separate operations.</li>
          </ul>
          <button className="eo-route-subaction" disabled={!available(status)} onClick={() => onSection("orders")}>Open an order's Proof</button>
        </article>
      </div>
    </section>
  );
}

export function WorkstationSettings({status, bridge, busy, run, onSection}: Base) {
  const {appearance, motion, selectAppearance, selectMotion} = useEvidencePreferences();
  const ws = status.workspace!;
  const current = status.versions;
  return (
    <section className="eo-route" data-design-file="nNnkgTZOBNkG8muy8AkIv1" data-design-node="5:455">
      {header("WORKSTATION SETTINGS", "Designed around the operator.",
        "Customize presentation without changing source access, capture, retention or authorization.")}
      <div className="eo-route-grid eo-route-grid-wide">
        <section className="eo-route-panel">
          <h2>Appearance</h2>
          <p className="eo-route-context">Choose the look that suits the workstation. This preference stays local.</p>
          {(["dark","light"] as const).map((value) => (
            <button key={value} className="eo-route-preference" onClick={() => selectAppearance(value)}
              aria-pressed={appearance === value}>
              <span><strong>{value === "dark" ? "Dark theme" : "Light theme"}</strong>
                <small>{value === "dark" ? "Low-light warehouse operations" : "Bright workstations and offices"}</small>
              </span>
              <span className="eo-route-tag">{appearance === value ? "ACTIVE" : "SELECT"}</span>
            </button>
          ))}
          <button className="eo-route-preference" onClick={() => selectMotion(motion === "normal" ? "reduced" : "normal")}
            aria-pressed={motion === "reduced"}>
            <span><strong>Reduced motion</strong><small>Remove nonessential animated transitions</small></span>
            <span className="eo-route-tag">{motion === "reduced" ? "ON" : "OFF"}</span>
          </button>
        </section>
        <section className="eo-route-panel">
          <h2>Automation & safeguards</h2>
          <p className="eo-route-context">Controls enforced by the existing service, not switches that alter evidence policy.</p>
          <ul className="eo-route-checks">
            <li>Source permissions must be approved before ongoing collection.</li>
            <li>Uncertain identity relationships must remain unresolved for review.</li>
            <li>Original evidence and accepted revisions are retained independently.</li>
            <li>Interrupted collection is governed by the protected local queue.</li>
          </ul>
          <div className="eo-runtime-details">
            <div><span>Environment</span><strong>{status.environment}</strong></div>
            <div><span>Service version</span><strong>{current?.service || "Not reported"}</strong></div>
            <div><span>Source grants</span><strong>{ws.sources.filter(s => s.roles.length).length}</strong></div>
            <div><span>Connection</span><strong>{status.transport?.state || "Unknown"}</strong></div>
          </div>
        </section>
      </div>
      <section className="eo-route-panel eo-route-advanced">
        <div><h2>Advanced tools remain available</h2><p>Access your connection permissions, redacted diagnostics and authorized portal without cluttering daily operations.</p></div>
        <div className="eo-route-buttons">
          <button className="eo-route-action" onClick={() => onSection("connections")}>Connection settings</button>
          <button className="eo-route-subaction" disabled={busy} onClick={() => void run(() => bridge.exportDiagnostics())}>Export diagnostics</button>
          <button className="eo-route-subaction" disabled={busy} onClick={() => void run(() => bridge.openPortal())}>Online portal</button>
        </div>
      </section>
    </section>
  );
}
