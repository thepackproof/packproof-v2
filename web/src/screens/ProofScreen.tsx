import { SignatureWorkbench } from "../components/SignatureWorkbench";
import { PrivacySharePanel } from "../components/PrivacySharePanel";
import { WorkspaceProofRecord } from "../components/WorkspaceProofRecord";
import { EvidenceReviewPanel } from "../components/EvidenceReviewPanel";
import { useState } from "react";
import { useViewState } from "../navigation-context";
import { SharingCode } from "../components/SharingCode";
import { RetentionPanel } from "../components/RetentionPanel";
import type { PackProofApi } from "../api/client";
import { deriveNextAction } from "@packproof/copy/next-action";
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
import { IconMore } from "../components/Icons";
import { PageHeader } from "../components/PageHeader";
import {
  AttestationList,
  EvidenceList,
  ParticipantList,
  ProofOverview,
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
  shareNotice?: string | null;
  api?: PackProofApi;
  shareLink?: string | null;
  uploadProgress?: number | null;
  onRecoverCapture?: () => Promise<File | null>;
  onOpenInvite?: () => void;
  onOpenFinalize?: () => void;
  onOpenEvent?: (event: ChronologyEntry) => void;
  onOpenStation?: () => void;
  onShare?: (scope?: "SUMMARY" | "EVIDENCE_VIEW") => void;
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [detailed, setDetailed] = useViewState(`proof.${window.location.pathname}.detailed`, false);
  const proof = props.proof;
  const role = proof?.participants.find(
    (participant) => participant.userId === props.currentUserId,
  )?.role;
  const grading = isGradingWorkflow(proof?.workflowType);
  const committed =
    proof?.evidence.filter((item) => item.validationStatus === "COMMITTED").length ?? 0;
  const localAction = proof
    ? deriveNextAction({
        role,
        proofStatus: proof.status,
        committedEvidenceCount: committed,
        captureStatus: "idle",
        hasLocalCapture: false,
        captureBelongsToProof: false,
        uploadPercent: null,
        offline: false,
      })
    : null;
  const serverAction = proof?.nextAction ?? null;
  const actionTitle = serverAction?.title || localAction?.label || "";
  const actionHint = serverAction?.hint || localAction?.hint || "";
  const actionEnabled = grading
    ? Boolean(
        serverAction &&
          serverAction.type !== "WAIT_FOR_RECEIPT" &&
          serverAction.type !== "COMPLETE",
      )
    : Boolean(localAction?.enabled && localAction.label);
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
    if (!localAction) {
      return;
    }
    if (
      localAction.key === "start_capture" ||
      localAction.key === "review_recording" ||
      localAction.key === "retry_upload"
    ) {
      props.onOpenStation?.();
      return;
    }
    if (localAction.key === "finalize") {
      props.onOpenFinalize?.();
      return;
    }
    if (localAction.key === "add_participant") {
      props.onOpenInvite?.();
    }
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
        title={proof.transaction.itemTitle?.trim() || "PackProof"}
        onBack={props.onBack}
        right={
          <button
            type="button"
            className="icon-btn"
            aria-label="Proof actions"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <IconMore />
          </button>
        }
      />
      {menuOpen ? (
        <div className="action-sheet" role="menu">
          {props.onShare ? (
            <button
              className="btn btn-secondary"
              type="button"
              disabled={props.busy}
              onClick={() => {
                reviewSharing();
              }}
            >
              Preview sharing
            </button>
          ) : null}
          {props.onShare ? (
            <button
              className="btn btn-secondary"
              type="button"
              disabled={props.busy}
              onClick={() => {
                reviewSharing();
              }}
            >
              Choose shared evidence
            </button>
          ) : null}
          {canInvite ? (
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setMenuOpen(false);
                props.onOpenInvite?.();
              }}
            >
              {inviteParticipantTitle(proof.workflowType)}
            </button>
          ) : null}
        </div>
      ) : null}
      {props.error ? (
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      ) : null}
      {props.shareNotice ? <p className="note">{props.shareNotice}</p> : null}
      {props.shareLink ? <SharingCode url={props.shareLink} /> : null}

      <WorkspaceProofRecord
        key={`${proof.proofId}.${props.currentUserId}.${props.api?.recoveryScope || location.origin}`}
        proof={proof}
        currentUserId={props.currentUserId}
        role={role}
        api={props.api}
        busy={props.busy}
        loadEvidence={props.onLoadEvidence}
        onOpenEvent={props.onOpenEvent}
        onOpenReceipt={props.onOpenReceipt}
        onReviewSharing={props.api && role === "SELLER" ? reviewSharing : undefined}
        trackingTools={<>
      {proof.captureShipping ? <section className="panel stack" aria-label="Captured shipping label">
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
            <p className="note">Carrier observations will appear here after they are recorded.</p>
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
            <h2>
              {proof.shipmentSync?.provider === "easypost"
                ? "Tracking via EasyPost"
                : "Trusted shipment sync"}
            </h2>
            <p className="note">
              {proof.shipmentSync?.provider === "easypost"
                ? "PackProof asks EasyPost for carrier tracking observations. EasyPost is not the carrier."
                : "Asks PackProof to refresh observations through the server-side trusted adapter."}
            </p>
            <button
              className="btn"
              type="button"
              disabled={props.busy}
              onClick={props.onSyncShipment}
            >
              Sync shipment
            </button>
          </section>
        ) : null}
      </div>

        </>}
      />

      {actionTitle || actionHint ? (
        <section className="section">
          <p className="kicker">Next step</p>
          <p className="card-title">{actionTitle}</p>
          {actionHint ? <p>{actionHint}</p> : null}
          {grading && nextActionNeedsCapture(serverAction?.type) ? (
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
          ) : localAction?.kind === "success" ? (
            <p className="integrity-mark">{actionTitle}</p>
          ) : null}
        </section>
      ) : null}

      {!grading && role === "SELLER" && proof.status !== "FINALIZED" && !actionEnabled ? <section className="section stack"><h2>Record your packing</h2><p>Use the PackProof camera to show the item, packing, and seal. Unfinished recordings stay on this device for recovery.</p><button className="btn" onClick={props.onOpenStation}>Open camera</button></section> : null}
      {!grading && proof.status === "FINALIZED" && props.onOpenReceipt ? (
        <button className="btn btn-secondary" onClick={props.onOpenReceipt}>
          Document receipt or return
        </button>
      ) : null}
      {props.api && <details className="proof-supporting-tools" onToggle={event => { if (!event.currentTarget.open) event.currentTarget.querySelectorAll<HTMLMediaElement>("video,audio").forEach(media => media.pause()); }} open={new URLSearchParams(location.search).has("historyShare") || new URLSearchParams(location.search).has("snapshot") || /(?:anchor|evidence)=/.test(location.hash) ? true : undefined}>
        <summary>Explore this Proof · Replay, Ask, Case, Compare and History</summary>
        <SignatureWorkbench key={proof.proofId} api={props.api} proof={proof} />
      </details>}
      {props.api && role === "SELLER" && <details className="proof-supporting-tools">
        <summary>Buyer receipt and sharing</summary>
        <div id="sharing" data-context-anchor="sharing"><PrivacySharePanel key={proof.proofId} api={props.api} proof={proof} /></div>
      </details>}
      <div className="review-mode" role="group" aria-label="Proof detail level">
        <button
          className={detailed ? "btn btn-secondary" : "btn"}
          onClick={() => setDetailed(false)}
          aria-pressed={!detailed}
        >
          Summary
        </button>
        <button
          className={detailed ? "btn" : "btn btn-secondary"}
          onClick={() => setDetailed(true)}
          aria-pressed={detailed}
        >
          Claims and evidence
        </button>
      </div>
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
      {proof.assets && proof.assets.length > 0 ? (
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

      {proof.observations && proof.observations.length > 0 ? (
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

      <ContinuityCompare proof={proof} loadEvidence={props.onLoadEvidence} />


      <div>
        <ProofOverview proof={proof} />
        <ParticipantList proof={proof} currentUserId={props.currentUserId} />
      </div>

      <div className="stack">
        <EvidenceList proof={proof} />
        <AttestationList proof={proof} />
      </div>


      {detailed ? <TechnicalDetails proof={proof} /> : null}
    </main>
  );
}

function shippingLine(proof: CanonicalProof): string {
  const shipping = proof.transaction.shipping;
  const parts = [shipping?.carrier, shipping?.service, shipping?.trackingNumber].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "No shipping details";
}
