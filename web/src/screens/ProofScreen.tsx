import { MediaPrivacyTools } from "../components/MediaPrivacyTools";
import { EvidenceResponsePanel } from "../components/EvidenceResponsePanel";
import { SignatureWorkbench } from "../components/SignatureWorkbench";
import { PrivacySharePanel } from "../components/PrivacySharePanel";
import { WorkspaceProofRecord } from "../components/WorkspaceProofRecord";
import { EvidenceReviewPanel } from "../components/EvidenceReviewPanel";
import { useEffect, useRef, useState } from "react";
import { useViewState } from "../navigation-context";
import { RetentionPanel } from "../components/RetentionPanel";
import type { PackProofApi } from "../api/client";
import { listRecoverableRecordings, type LocalRecordingSummary } from "../capture-queue";
import { presentProof, withRecording } from "../proof-presentation";
import {
  assetItemLabel,
  inviteParticipantTitle,
  isGradingWorkflow,
  nextActionNeedsCapture,
  observationProgressLabel,
  workflowActionFor,
} from "@packproof/copy/custody";
import type { CanonicalProof, ChronologyEntry, ShipmentIntegrityView } from "../api/types";
import { ContinuityCompare } from "../components/ContinuityCompare";
import { Glyph } from "../site/Brand";
import { IconMore } from "../components/Icons";
import { PageHeader } from "../components/PageHeader";
import {
  AttestationList,
  EvidenceList,
  ParticipantList,
  ShipmentIntegrityPanel,
  TechnicalDetails,
} from "../components/ProofRecord";
import { GradingCapturePanel } from "./GradingCapturePanel";

export function ProofScreen(props: {
  proof: CanonicalProof | null;
  shipmentIntegrity: ShipmentIntegrityView | null;
  currentUserId: string;
  loading: boolean;
  error: string | null;
  busy: boolean;
  development?: boolean;
  api?: PackProofApi;
  uploadProgress?: number | null;
  onRecoverCapture?: () => Promise<File | null>;
  onOpenInvite?: () => void;
  onOpenFinalize?: () => void;
  onOpenEvent?: (event: ChronologyEntry) => void;
  onOpenStation?: () => void;
  onWorkflowAction?: (
    action:
      | "document"
      | "pack"
      | "handoff"
      | "receive"
      | "compare"
      | "output"
      | "return-pack"
      | "final-receipt",
    body?: Record<string, unknown>,
  ) => Promise<void>;
  onCommitCapture?: (
    files: Array<{ slot: string; file: File }>,
  ) => Promise<Array<{ slot: string; evidenceId: string }>>;
  onLoadEvidence?: (evidenceId: string) => Promise<Blob>;
  onBack?: () => void;
  onOpenReceipt?: () => void;
  onExport?: () => Promise<void>;
  onVerify?: () => Promise<{
    integrity: { manifestDigestValid: boolean; manifestSha256: string } | null;
  }>;
  onImportShipmentEvents?: (throughEventType?: string) => void;
  onSyncShipment?: () => void;
  onConnectTrustedDemo?: () => void;
}) {
  const [localWork, setLocalWork] = useState<LocalRecordingSummary>();
  const hasLocalWork = Boolean(localWork);
  useEffect(() => {
    let active = true;
    const refresh = () => { if (props.api && props.proof) void listRecoverableRecordings(props.currentUserId, props.api).then(rows => { if (active) setLocalWork(rows.find(row => row.proofId === props.proof?.proofId && !row.finalized && !row.submitted)); }).catch(() => {}); };
    refresh(); window.addEventListener("packproof:records-updated", refresh);
    return () => { active = false; window.removeEventListener("packproof:records-updated", refresh); };
  }, [props.api, props.currentUserId, props.proof?.proofId]);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const opensEvidenceTools = new URLSearchParams(location.search).has("historyShare") || new URLSearchParams(location.search).has("snapshot") || /(?:anchor|evidence)=/.test(location.hash);
  const [detailed, setDetailed] = useViewState(`proof.${window.location.pathname}.detailed`, opensEvidenceTools);
  const proof = props.proof;
  const role = proof?.participants.find(
    (participant) => participant.userId === props.currentUserId,
  )?.role;
  const grading = isGradingWorkflow(proof?.workflowType);
  const presentation = proof ? withRecording(presentProof(proof, props.currentUserId), localWork) : null;
  const serverAction = proof?.nextAction ?? null;
  const actionTitle = presentation?.nextAction.label || "";
  const actionHint = presentation?.needsAttention ? (grading ? serverAction?.hint || "" : presentation.nextAction.type === "RESUME_UPLOAD" ? "Your original is saved on this device. Resume saving it to this Proof." : presentation.nextAction.type === "RECOVER_RECORDING" ? "Review the saved recording. Missing footage remains missing." : presentation.nextAction.type === "REVIEW_CONFIRM" ? "Review your recording and confirm the packing record." : "Show the item, packing, seal and shipping label in one recording.") : "";
  const actionEnabled = Boolean(presentation?.needsAttention);
  const canInvite = Boolean(proof && role === "SELLER" && proof.status !== "FINALIZED");
  const canImportDemoCarrier =
    Boolean(props.development) &&
    proof &&
    role === "SELLER" &&
    Boolean(props.onImportShipmentEvents);
  const canSyncShipment = Boolean(proof?.shipmentSync?.available && props.onSyncShipment);
  const canConnectTrustedDemo =
    Boolean(props.development) &&
    proof &&
    role === "SELLER" &&
    !proof.shipmentSync?.available &&
    Boolean(props.onConnectTrustedDemo);

  if (props.loading && !proof) {
    return (
      <main className="page">
        <p className="empty">Loading Proof…</p>
      </main>
    );
  }

  if (props.error && !proof) {
    return (
      <main className="page">
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      </main>
    );
  }

  if (!proof) {
    return (
      <main className="page">
        <p className="empty">This Proof is not available.</p>
      </main>
    );
  }

  function handlePrimary() {
    if (grading && serverAction) {
      if (serverAction.type === "FINALIZE") {
        props.onOpenFinalize?.();
        return;
      }
      if (nextActionNeedsCapture(serverAction.type)) {
        return;
      }
      const actionName = workflowActionFor(serverAction.type);
      if (actionName) {
        void props.onWorkflowAction?.(actionName, {
          assetId: serverAction.assetId,
          transferId: serverAction.transferId,
          recipe: serverAction.captureRecipe,
        });
      }
      return;
    }
    if (!presentation) return;
    if (["RECORD_PACKING", "RESUME_UPLOAD", "RECOVER_RECORDING", "CONTINUE_RECORDING"].includes(presentation.nextAction.type)) { props.onOpenStation?.(); return; }
    if (presentation.nextAction.type === "REVIEW_CONFIRM") { if (hasLocalWork) props.onOpenStation?.(); else props.onOpenFinalize?.(); return; }
    if (presentation.nextAction.type === "WORKFLOW_ACTION") props.onOpenReceipt?.();
  }

  function reviewSharing() {
    setMenuOpen(false);
    const sharing = document.getElementById("sharing");
    const details = sharing?.closest("details");
    if (details) details.open = true;
    sharing?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  return (
    <main className="page stack">
      <PageHeader
        title="Proof"
        onBack={props.onBack}
        right={
          <div className="proof-header-actions">{props.api && presentation?.share.available && <button className="btn btn-secondary" type="button" onClick={reviewSharing}><Glyph name="share" size={18} />Share</button>}<button
            type="button"
            ref={menuTrigger}
            className="icon-btn"
            aria-label="Proof actions"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <IconMore />
          </button></div>
        }
      />
      {menuOpen ? (
        <div className="action-sheet record-action-sheet" role="group" aria-label="Proof actions" onKeyDown={event => { if (event.key === "Escape") { setMenuOpen(false); menuTrigger.current?.focus(); } }}>
          <button className="btn btn-secondary" onClick={() => { setMenuOpen(false); setDetailed(true); requestAnimationFrame(() => document.getElementById("proof-tools")?.scrollIntoView({ block: "start", behavior: "smooth" })); }}><Glyph name="file" size={18} /> Evidence and claim tools</button>
          {!grading && ["SELLER", "BUYER"].includes(role || "") && proof.status === "FINALIZED" && props.onOpenReceipt && <button className="btn btn-secondary" onClick={() => { setMenuOpen(false); props.onOpenReceipt?.(); }}><Glyph name="box" size={18} /> Document receipt or return</button>}
          {canInvite ? (
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setMenuOpen(false);
                props.onOpenInvite?.();
              }}
            >
              <Glyph name="mail" size={18} /> {inviteParticipantTitle(proof.workflowType)}
            </button>
          ) : null}
        </div>
      ) : null}
      {props.error ? (
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      ) : null}

      <WorkspaceProofRecord
        key={`${proof.proofId}.${props.currentUserId}.${props.api?.recoveryScope || location.origin}`}
        proof={proof}
        presentation={presentation || undefined}
        currentUserId={props.currentUserId}
        role={role}
        api={props.api}
        busy={props.busy}
        loadEvidence={props.onLoadEvidence}
        onOpenEvent={props.onOpenEvent}
        onOpenReceipt={props.onOpenReceipt}
        onReviewSharing={props.api && presentation?.share.available ? reviewSharing : undefined}
        nextAction={<>
      {actionEnabled ? (
        <section className="proof-next-action">

          {actionHint ? <p>{actionHint}</p> : null}
          {grading && actionEnabled && nextActionNeedsCapture(serverAction?.type) ? (
            <GradingCapturePanel
              recipe={serverAction?.captureRecipe}
              busy={props.busy}
              onCommit={async (files) => {
                const committedSlots = await props.onCommitCapture?.(files);
                const actionName = workflowActionFor(serverAction?.type);
                if (!actionName || !committedSlots) {
                  return;
                }
                await props.onWorkflowAction?.(actionName, {
                  assetId: serverAction?.assetId,
                  transferId: serverAction?.transferId,
                  recipe: serverAction?.captureRecipe,
                  evidence: committedSlots,
                });
              }}
            />
          ) : actionEnabled ? (
            <div className="btn-row" style={{ marginTop: "0.75rem" }}>
              <button className="btn" type="button" disabled={props.busy} onClick={handlePrimary}>
                {actionTitle}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

        </>}
        trackingTools={<details className="record-order-details"><summary>Shipping details and tools</summary>
      {proof.captureShipping && proof.captureShipping.observations.length > 0 ? <section className="panel stack" aria-label="Captured shipping label">
        <h2>Shipping label captured during packing</h2>
        <p>{proof.captureShipping.observations[0]?.trackingNumber} · {Math.floor((proof.captureShipping.observations[0]?.detectedAtMs??0)/1000)}s into the recording</p>
        <p className="muted">Label recognition and timing are reported by the recording device. Carrier observations appear separately below.</p>
        <p>{proof.captureShipping.registration.mode==='test' ? 'Test tracking data · ' : ''}
          {proof.captureShipping.registration.state==='REGISTERED' ? `${proof.captureShipping.registration.carrier??'Carrier'} tracking connected`
            : proof.captureShipping.registration.errorCode==='SHIPPO_TEST_TRACKING_ONLY' ? 'Tracking number attached · live Shippo access needed for this package'
            : proof.captureShipping.registration.errorCode==='SHIPMENT_CARRIER_REQUIRED' ? 'Tracking number attached · choose a carrier in shipping information'
            : proof.captureShipping.registration.state==='WAITING_FOR_CONNECTION' ? 'Tracking number attached · carrier connection needed'
            : proof.captureShipping.registration.state==='FAILED' ? 'Tracking number attached · carrier lookup needs attention'
            : 'Tracking number attached · carrier update pending'}</p>
      </section> : null}
      <div className="stack">
        {proof.status === "FINALIZED" ? (
          <ShipmentIntegrityPanel integrity={props.shipmentIntegrity} />
        ) : (
          <section className="section">
            <h2>Shipping</h2>
            <p className="meta">{shippingLine(proof)}</p>
          </section>
        )}
        {canImportDemoCarrier ? (
          <section className="section stack">
            <h2>Demo shipment observations</h2>
            <p className="note">
              Imports a reference carrier timeline for this transaction. This is not a live carrier
              connection. Observations may arrive after the core Proof is finalized and do not
              change the core manifest.
            </p>
            <div className="btn-row">
              {(
                [
                  ["LABEL_CREATED", "Label created"],
                  ["CARRIER_ACCEPTED", "Accepted"],
                  ["WEIGHT_RECORDED", "Weight"],
                  ["IN_TRANSIT", "In transit"],
                  ["OUT_FOR_DELIVERY", "Out for delivery"],
                  ["DELIVERED", "Delivered"],
                ] as const
              ).map(([eventType, label]) => (
                <button
                  key={eventType}
                  className="btn btn-secondary"
                  type="button"
                  disabled={props.busy}
                  onClick={() => props.onImportShipmentEvents?.(eventType)}
                >
                  Import {label}
                </button>
              ))}
              <button
                className="btn"
                type="button"
                disabled={props.busy}
                onClick={() => props.onImportShipmentEvents?.()}
              >
                Import remaining demo observations
              </button>
            </div>
          </section>
        ) : null}
        {canConnectTrustedDemo ? (
          <section className="section stack">
            <h2>Trusted demo (development)</h2>
            <p className="note">
              Seeds a fake trusted carrier connection for this transaction. Credentials stay on the
              server.
            </p>
            <button
              className="btn"
              type="button"
              disabled={props.busy}
              onClick={props.onConnectTrustedDemo}
            >
              Connect trusted demo
            </button>
          </section>
        ) : null}
        {canSyncShipment ? (
          <section className="section stack">
            <h2>Refresh tracking</h2>
            <p className="note">
              Check for new carrier reports. This does not change the locked packing record.
            </p>
            <button
              className="btn"
              type="button"
              disabled={props.busy}
              onClick={props.onSyncShipment}
            >
              Refresh tracking
            </button>
          </section>
        ) : null}
      </div>

        </details>}
      />

      {detailed && props.api && <details id="proof-tools" className="proof-supporting-tools" onToggle={event => { if (!event.currentTarget.open) event.currentTarget.querySelectorAll<HTMLMediaElement>("video,audio").forEach(media => media.pause()); }} open={new URLSearchParams(location.search).has("historyShare") || new URLSearchParams(location.search).has("snapshot") || /(?:anchor|evidence)=/.test(location.hash) ? true : undefined}>
        <summary>Evidence tools</summary>
        <SignatureWorkbench userId={props.currentUserId} key={`${proof.proofId}.${props.currentUserId}.${props.api.recoveryScope}`} api={props.api} proof={proof} />
      </details>}
      {props.api && presentation?.share.available && <details className="proof-supporting-tools">
        <summary>Share Proof</summary>
        <div id="sharing" data-context-anchor="sharing"><PrivacySharePanel key={proof.proofId} api={props.api} proof={proof} currentUserId={props.currentUserId} /></div>
      </details>}
      {detailed ? (
        <EvidenceReviewPanel
          key={proof.proofId}
          proof={proof}
          onVerify={props.onVerify}
          onExport={props.onExport}
        />
      ) : null}
      {detailed && props.api ? (
        <RetentionPanel api={props.api} proofId={proof.proofId} userId={props.currentUserId} />
      ) : null}
      {detailed && proof.assets && proof.assets.length > 0 ? (
        <section className="section">
          <h2>Items</h2>
          <ul className="card-list">
            {proof.assets.map((asset) => (
              <li key={asset.assetId}>
                <div className="card-title">{assetItemLabel(asset)}</div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {detailed && proof.observations && proof.observations.length > 0 ? (
        <section className="section">
          <h2>Progress</h2>
          <ul className="card-list">
            {proof.observations.map((observation) => (
              <li key={observation.observationId}>
                <div className="card-title">
                  {observation.label || observationProgressLabel(observation.type)}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {detailed && <ContinuityCompare proof={proof} loadEvidence={props.onLoadEvidence} />}


      <details className="proof-supporting-tools"><summary>Participants and attestation</summary><ParticipantList proof={proof} currentUserId={props.currentUserId} /><AttestationList proof={proof} /></details>

      {detailed && <div className="stack">
        <EvidenceList proof={proof} />
      </div>}


      {props.api && proof.status === "FINALIZED" && <EvidenceResponsePanel userId={props.currentUserId} key={proof.proofId} api={props.api} proofId={proof.proofId} role={role ?? ""} />}
      {detailed && props.api && <MediaPrivacyTools api={props.api} proof={proof} />}
      {detailed ? <><TechnicalDetails proof={proof} /><button className="btn btn-secondary" onClick={() => setDetailed(false)}>Close details</button></> : null}
    </main>
  );
}

function shippingLine(proof: CanonicalProof): string {
  const shipping = proof.transaction.shipping;
  const parts = [shipping?.carrier, shipping?.service, shipping?.trackingNumber].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "No shipping details";
}
