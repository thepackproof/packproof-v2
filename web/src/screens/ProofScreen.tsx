import { useState } from "react";
import { deriveNextAction } from "@packproof/copy/next-action";
import {
  assetItemLabel,
  inviteParticipantTitle,
  isGradingWorkflow,
  nextActionNeedsCapture,
  observationProgressLabel,
  participantFacingRole,
  workflowActionFor,
} from "@packproof/copy/custody";
import { moneyLabel, orderReferenceLabel, quantityLabel, shippingSummary } from "@packproof/copy/format";
import { humanProofStatus } from "@packproof/copy/status";
import type { CanonicalProof, ChronologyEntry, ShipmentIntegrityView } from "../api/types";
import { ContinuityCompare } from "../components/ContinuityCompare";
import { IconMore } from "../components/Icons";
import { PageHeader } from "../components/PageHeader";
import {
  AttestationList,
  EventTimeline,
  EvidenceList,
  ParticipantList,
  ProofOverview,
  ShipmentIntegrityPanel,
  TechnicalDetails,
} from "../components/ProofRecord";
import { StatusBadge } from "../components/StatusBadge";
import { GradingCapturePanel } from "./GradingCapturePanel";

export function ProofScreen(props: {
  proof: CanonicalProof | null;
  shipmentIntegrity: ShipmentIntegrityView | null;
  currentUserId: string;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  busy: boolean;
  development?: boolean;
  shareNotice?: string | null;
  onOpenInvite?: () => void;
  onOpenFinalize?: () => void;
  onOpenEvent?: (event: ChronologyEntry) => void;
  onOpenStation?: () => void;
  onShare?: () => void;
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
  onCommitCapture?: (files: Array<{ slot: string; file: File }>) => Promise<Array<{ slot: string; evidenceId: string }>>;
  onDownloadPackage?: () => Promise<void>;
  onLoadEvidence?: (evidenceId: string) => Promise<Blob>;
  onBack?: () => void;
  onImportShipmentEvents?: (throughEventType?: string) => void;
  onSyncShipment?: () => void;
  onConnectTrustedDemo?: () => void;
}) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const proof = props.proof;
  const role = proof?.participants.find((participant) => participant.userId === props.currentUserId)
    ?.role;
  const grading = isGradingWorkflow(proof?.workflowType);
  const committed = proof?.evidence.filter((item) => item.validationStatus === "COMMITTED").length ?? 0;
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
    ? Boolean(serverAction && serverAction.type !== "WAIT_FOR_RECEIPT" && serverAction.type !== "COMPLETE")
    : Boolean(localAction?.enabled && localAction.label);
  const canInvite = Boolean(proof && role === "SELLER" && proof.status !== "FINALIZED");
  const canImportDemoCarrier =
    Boolean(props.development) && proof && role === "SELLER" && Boolean(props.onImportShipmentEvents);
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
          <p>{props.error}</p>
          {props.onRetry ? <button type="button" className="btn btn-secondary" disabled={props.loading} onClick={props.onRetry}>Try again</button> : null}
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
    if (localAction.key === "start_capture" || localAction.key === "review_recording" || localAction.key === "retry_upload") {
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

  const summaryLine = [
    moneyLabel(proof.transaction.transactionValue, proof.transaction.currency),
    quantityLabel(proof.transaction.quantity),
    shippingSummary(proof.transaction.shipping ?? {}),
  ]
    .filter(Boolean)
    .join(" • ");

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
                setMenuOpen(false);
                props.onShare?.();
              }}
            >
              Share viewing link
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
      <div className="header-block">
        {summaryLine ? <p className="meta">{summaryLine}</p> : null}
        {proof.transaction.externalReference ? (
          <p className="meta">{orderReferenceLabel(proof.transaction.externalReference)}</p>
        ) : null}
        <div className="row">
          <StatusBadge
            label={humanProofStatus({
              proofStatus: proof.status,
              latestShipmentEventType: proof.shipmentObservations?.latest?.eventType,
              hasShipping: Boolean(proof.transaction.shipping?.carrier || proof.transaction.shipping?.trackingNumber),
            })}
          />
          {role ? <span className="meta">You are the {participantFacingRole(proof.workflowType, role)}</span> : null}
        </div>
      </div>
      {props.error ? (
        <div className="banner banner-error" role="alert">
          <p>{props.error}</p>
          {props.onRetry ? <button type="button" className="btn btn-secondary" disabled={props.loading} onClick={props.onRetry}>Try again</button> : null}
        </div>
      ) : null}
      {props.shareNotice ? <p className="note">{props.shareNotice}</p> : null}

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
                <div className="card-title">{observation.label || observationProgressLabel(observation.type)}</div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ContinuityCompare proof={proof} loadEvidence={props.onLoadEvidence} />

      <EventTimeline proof={proof} onSelect={props.onOpenEvent} />

      <div>
          <ProofOverview proof={proof} />
          <ParticipantList proof={proof} currentUserId={props.currentUserId} />
      </div>

      <div className="stack">
          <EvidenceList proof={proof} loadEvidence={props.onLoadEvidence} />
          <AttestationList proof={proof} />
      </div>

      <div className="stack">
          {proof.status === "FINALIZED" ? (
            <ShipmentIntegrityPanel integrity={props.shipmentIntegrity} />
          ) : (
            <section className="section">
              <h2>Shipping</h2>
              <p className="meta">
                {shippingLine(proof)}
              </p>
              <p className="note">Carrier observations will appear here after they are recorded.</p>
            </section>
          )}
          {canImportDemoCarrier ? (
            <section className="section stack">
              <h2>Demo shipment observations</h2>
              <p className="note">
                Imports a reference carrier timeline for this transaction. This is not a live carrier
                connection. Observations may arrive after the core Proof is finalized and do not change
                the core manifest.
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
              <button className="btn" type="button" disabled={props.busy} onClick={props.onConnectTrustedDemo}>
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
              <button className="btn" type="button" disabled={props.busy} onClick={props.onSyncShipment}>
                Sync shipment
              </button>
            </section>
          ) : null}
      </div>

      {proof.status === "FINALIZED" && props.onDownloadPackage ? (
        <section className="section export-panel">
          <div>
            <p className="kicker">Keep your record</p>
            <h2>Download verification package</h2>
            <p className="note">Save the finalized record and its SHA-256 digest for independent integrity checks. Download media separately from Evidence above.</p>
          </div>
          <button type="button" className="btn btn-secondary" disabled={exporting} onClick={async () => {
            setExporting(true);
            setExportError(null);
            try { await props.onDownloadPackage?.(); }
            catch { setExportError("The download could not be prepared. Please try again."); }
            finally { setExporting(false); }
          }}>{exporting ? "Preparing download…" : "Download package"}</button>
          {exportError ? <p role="alert" className="note">{exportError}</p> : null}
        </section>
      ) : null}
      <TechnicalDetails proof={proof} />
    </main>
  );
}

function shippingLine(proof: CanonicalProof): string {
  const shipping = proof.transaction.shipping;
  const parts = [shipping?.carrier, shipping?.service, shipping?.trackingNumber].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "No shipping details";
}
