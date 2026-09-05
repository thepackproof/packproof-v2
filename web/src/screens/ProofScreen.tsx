import { EvidencePlayer } from "../components/EvidencePlayer";
import { EvidenceReviewPanel } from "../components/EvidenceReviewPanel";
import { useEffect, useRef, useState } from "react";
import { CapturePreview } from "../components/CapturePreview";
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
  participantFacingRole,
  workflowActionFor,
} from "@packproof/copy/custody";
import {
  moneyLabel,
  orderReferenceLabel,
  quantityLabel,
  shippingSummary,
} from "@packproof/copy/format";
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
  const [detailed, setDetailed] = useState(false);
  const packingInput = useRef<HTMLInputElement>(null);
  const [packingFile, setPackingFile] = useState<File | null>(null);
  useEffect(() => {
    let active = true;
    void props
      .onRecoverCapture?.()
      .then((file) => {
        if (active && file) setPackingFile(file);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [props.proof?.proofId]);
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
      if (!grading && role === "SELLER") packingInput.current?.click();
      else props.onOpenStation?.();
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
          {props.onShare ? (
            <button
              className="btn btn-secondary"
              type="button"
              disabled={props.busy}
              onClick={() => {
                setMenuOpen(false);
                props.onShare?.("EVIDENCE_VIEW");
              }}
            >
              Share evidence viewing link
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
              hasShipping: Boolean(
                proof.transaction.shipping?.carrier || proof.transaction.shipping?.trackingNumber,
              ),
            })}
          />
          {role ? (
            <span className="meta">
              You are the {participantFacingRole(proof.workflowType, role)}
            </span>
          ) : null}
        </div>
      </div>
      {props.error ? (
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      ) : null}
      {props.shareNotice ? <p className="note">{props.shareNotice}</p> : null}
      {props.shareLink ? <SharingCode url={props.shareLink} /> : null}

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

      {!grading && role === "SELLER" && proof.status !== "FINALIZED" && props.onCommitCapture ? (
        <section className="section stack">
          <h2>Record your packing</h2>
          <p className="note">
            Show the item and identifying details, place it in the package, then show the seal.
          </p>
          <label className="field">
            <span>Packing video</span>
            <input
              ref={packingInput}
              type="file"
              accept="video/*"
              capture="environment"
              disabled={props.busy}
              onChange={(event) => setPackingFile(event.target.files?.[0] ?? null)}
            />
          </label>
          {packingFile ? <CapturePreview file={packingFile} /> : null}
          {props.busy && props.uploadProgress != null ? (
            <p role="status">Preserving recording: {props.uploadProgress}%</p>
          ) : null}
          {packingFile ? (
            <p className="note">
              Review the recording, then save it. If the connection is interrupted, return to this
              Proof and retry to resume.
            </p>
          ) : null}
          {packingFile ? (
            <button
              className="btn"
              disabled={props.busy}
              onClick={() => {
                void props.onCommitCapture!([{ slot: "PACKING", file: packingFile }])
                  .then(() => setPackingFile(null))
                  .catch(() => undefined);
              }}
            >
              {props.busy ? "Preserving recording…" : "Use recording"}
            </button>
          ) : null}
        </section>
      ) : null}
      {!grading && proof.status === "FINALIZED" && props.onOpenReceipt ? (
        <button className="btn btn-secondary" onClick={props.onOpenReceipt}>
          Document receipt or return
        </button>
      ) : null}
      <EvidencePlayer key={proof.proofId} proof={proof} load={props.onLoadEvidence} />
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

      <EventTimeline proof={proof} onSelect={props.onOpenEvent} />

      <div>
        <ProofOverview proof={proof} />
        <ParticipantList proof={proof} currentUserId={props.currentUserId} />
      </div>

      <div className="stack">
        <EvidenceList proof={proof} />
        <AttestationList proof={proof} />
      </div>

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

      {detailed ? <TechnicalDetails proof={proof} /> : null}
    </main>
  );
}

function shippingLine(proof: CanonicalProof): string {
  const shipping = proof.transaction.shipping;
  const parts = [shipping?.carrier, shipping?.service, shipping?.trackingNumber].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "No shipping details";
}
