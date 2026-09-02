import { useEffect, useRef, useState } from "react";
import { FINALIZE_DISCLOSURE } from "@packproof/copy/errors";
import { deriveNextAction } from "@packproof/copy/next-action";
import {
  assetItemLabel,
  isGradingWorkflow,
  nextActionNeedsCapture,
  observationProgressLabel,
  workflowActionFor,
} from "@packproof/copy/custody";
import type { CanonicalProof, PublicProfileView, ShipmentIntegrityView } from "../api/types";
import { ContinuityCompare } from "../components/ContinuityCompare";
import {
  AttestationList,
  EventTimeline,
  EvidenceList,
  ParticipantList,
  ProofHeader,
  ProofOverview,
  ShipmentIntegrityPanel,
  TechnicalDetails,
} from "../components/ProofRecord";
import { invitationStateLabel, profileInitials } from "../format";
import { GradingCapturePanel } from "./GradingCapturePanel";

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_LENGTH = 2;

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "evidence", label: "Evidence" },
  { id: "shipping", label: "Shipping" },
  { id: "history", label: "History" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function ProofScreen(props: {
  proof: CanonicalProof | null;
  shipmentIntegrity: ShipmentIntegrityView | null;
  currentUserId: string;
  loading: boolean;
  error: string | null;
  busy: boolean;
  development?: boolean;
  shareNotice?: string | null;
  onInvite: (input: { inviteeUserId: string }) => Promise<void>;
  onAttest: (statement: string) => void;
  onFinalize: () => void;
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
  onLoadEvidence?: (evidenceId: string) => Promise<Blob>;
  onImportShipmentEvents?: (throughEventType?: string) => void;
  onSyncShipment?: () => void;
  onConnectTrustedDemo?: () => void;
  onSearchUsers: (query: string) => Promise<PublicProfileView[]>;
}) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [tab, setTab] = useState<TabId>("overview");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PublicProfileView[]>([]);
  const [searchStatus, setSearchStatus] = useState<"idle" | "loading" | "empty" | "ready" | "error">(
    "idle",
  );
  const searchGeneration = useRef(0);
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
  const canAttest = !grading && proof && proof.status !== "FINALIZED" && Boolean(role);
  const packingAttested = Boolean(
    proof?.attestations?.some((row) => row.statement === "PACKED_DESCRIBED_ITEM"),
  );
  const hasFulfillmentCapture = Boolean(
    proof?.evidence.some(
      (row) => row.validationStatus === "COMMITTED" && row.evidenceType === "FULFILLMENT_CAPTURE",
    ),
  );
  const merchantReady =
    proof?.participationPolicy === "COUNTERPARTY_OPTIONAL" &&
    proof.status !== "FINALIZED" &&
    packingAttested &&
    hasFulfillmentCapture;
  const canFinalize =
    !grading &&
    role === "SELLER" &&
    Boolean(
      merchantReady ||
        (proof?.participationPolicy !== "COUNTERPARTY_OPTIONAL" && proof?.status === "EVIDENCE_COMMITTED"),
    );
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

  useEffect(() => {
    if (!canInvite || !inviteOpen) {
      return;
    }
    const normalized = query.trim().replace(/^@+/, "").trim();
    if (normalized.length < SEARCH_MIN_LENGTH) {
      searchGeneration.current += 1;
      setResults([]);
      setSearchStatus("idle");
      return;
    }
    const generation = ++searchGeneration.current;
    setSearchStatus("loading");
    const handle = window.setTimeout(() => {
      void props
        .onSearchUsers(query.trim())
        .then((users) => {
          if (generation !== searchGeneration.current) {
            return;
          }
          setResults(users);
          setSearchStatus(users.length > 0 ? "ready" : "empty");
        })
        .catch(() => {
          if (generation !== searchGeneration.current) {
            return;
          }
          setSearchStatus("error");
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [canInvite, inviteOpen, query, props.onSearchUsers]);

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
        props.onFinalize();
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
      props.onFinalize();
      return;
    }
    if (localAction.key === "add_participant" || localAction.key === "getting_started") {
      setInviteOpen(true);
      setTab("overview");
    }
  }

  return (
    <main className="page stack">
      <ProofHeader proof={proof} role={role} />
      {props.error ? (
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      ) : null}
      {props.shareNotice ? <p className="note">{props.shareNotice}</p> : null}

      <div className="btn-row">
        {props.onShare ? (
          <button className="btn btn-secondary" type="button" disabled={props.busy} onClick={props.onShare}>
            Share viewing link
          </button>
        ) : null}
      </div>

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

      <div className="proof-tabs" role="tablist" aria-label="Proof sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="tab"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => {
              setTab(item.id);
              document.getElementById(`proof-panel-${item.id}`)?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              });
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div id="proof-panel-overview">
          <ProofOverview proof={proof} />
          <ParticipantList proof={proof} currentUserId={props.currentUserId} />
          {canInvite ? (
            <section className="section stack">
              <h2>{grading ? "Add a receiving participant" : "Add a participant"}</h2>
              {!inviteOpen ? (
                <button className="btn" type="button" onClick={() => setInviteOpen(true)}>
                  {grading ? "Add receiving participant" : "Add participant"}
                </button>
              ) : (
                <>
                  <p className="note">
                    Search PackProof accounts by username or name. Invitation links are not required.
                  </p>
                  <label className="field">
                    <span>Search by username or name</span>
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                  </label>
                  {searchStatus === "loading" ? <p className="empty">Searching…</p> : null}
                  {searchStatus === "empty" ? <p className="empty">No PackProof users match that search.</p> : null}
                  {searchStatus === "error" ? (
                    <p className="empty" role="alert">
                      Search failed. Edit the query to try again.
                    </p>
                  ) : null}
                  <ul className="card-list">
                    {results.map((user) => {
                      const state = user.invitationState ?? "NONE";
                      const canSend = state === "NONE" && !props.busy;
                      return (
                        <li key={user.userId} className="user-search-row">
                          <span className="avatar-placeholder" aria-hidden="true">
                            {profileInitials(user.displayName, user.username)}
                          </span>
                          <div className="user-search-copy">
                            <strong>{user.displayName || user.username}</strong>
                            <div className="meta">@{user.username}</div>
                          </div>
                          {canSend ? (
                            <button
                              className="btn"
                              type="button"
                              onClick={() => {
                                void props.onInvite({ inviteeUserId: user.userId }).then(() => {
                                  setResults((current) =>
                                    current.map((row) =>
                                      row.userId === user.userId ? { ...row, invitationState: "INVITED" } : row,
                                    ),
                                  );
                                });
                              }}
                            >
                              Invite
                            </button>
                          ) : (
                            <span className="meta">{invitationStateLabel(state)}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </section>
          ) : null}
          {canAttest ? (
            <section className="section">
              <h2>Record a statement</h2>
              <p className="note">
                This submits your statement to the Proof. PackProof records it. It does not endorse
                whether the statement is true.
              </p>
              <div className="btn-row">
                <button
                  className="btn"
                  type="button"
                  disabled={props.busy}
                  onClick={() => props.onAttest("PACKED_DESCRIBED_ITEM")}
                >
                  I packed the described item
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  disabled={props.busy}
                  onClick={() => props.onAttest("RECEIVED_PACKAGE")}
                >
                  I received this package
                </button>
              </div>
            </section>
          ) : null}
          {canFinalize ? (
            <section className="section">
              <h2>Complete the Proof</h2>
              <p className="note">{FINALIZE_DISCLOSURE}</p>
              <button className="btn" type="button" disabled={props.busy} onClick={props.onFinalize}>
                Finalize PackProof
              </button>
            </section>
          ) : null}
      </div>

      <div id="proof-panel-evidence" className="stack">
          <EvidenceList proof={proof} />
          <AttestationList proof={proof} />
      </div>

      <div id="proof-panel-shipping" className="stack">
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

      <div id="proof-panel-history">
        <EventTimeline proof={proof} />
      </div>

      <TechnicalDetails proof={proof} />
    </main>
  );
}

function shippingLine(proof: CanonicalProof): string {
  const shipping = proof.transaction.shipping;
  const parts = [shipping?.carrier, shipping?.service, shipping?.trackingNumber].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "No shipping details";
}
