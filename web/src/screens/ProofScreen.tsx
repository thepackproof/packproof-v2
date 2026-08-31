import { useEffect, useRef, useState } from "react";
import type { CanonicalProof, PublicProfileView, ShipmentIntegrityView } from "../api/types";
import {
  AttestationList,
  EventTimeline,
  EvidenceList,
  IntegrityPanel,
  ParticipantList,
  ProofHeader,
  ProofOverview,
  ShipmentIntegrityPanel,
} from "../components/ProofRecord";
import { invitationStateLabel, profileInitials } from "../format";

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_LENGTH = 2;

export function ProofScreen(props: {
  proof: CanonicalProof | null;
  shipmentIntegrity: ShipmentIntegrityView | null;
  currentUserId: string;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onInvite: (input: { inviteeUserId: string }) => Promise<void>;
  onAttest: (statement: string) => void;
  onFinalize: () => void;
  onImportShipmentEvents?: (throughEventType?: string) => void;
  onSyncShipment?: () => void;
  onConnectTrustedDemo?: () => void;
  onSearchUsers: (query: string) => Promise<PublicProfileView[]>;
}) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PublicProfileView[]>([]);
  const [searchStatus, setSearchStatus] = useState<"idle" | "loading" | "empty" | "ready" | "error">(
    "idle",
  );
  const searchGeneration = useRef(0);
  const proof = props.proof;
  const role = proof?.participants.find((participant) => participant.userId === props.currentUserId)
    ?.role;
  const canAttest = proof && proof.status !== "FINALIZED" && Boolean(role);
  const packingAttested = Boolean(
    proof?.attestations?.some((row) => row.statement === "PACKED_DESCRIBED_ITEM"),
  );
  const canFinalize =
    role === "SELLER" &&
    (proof?.status === "EVIDENCE_COMMITTED" ||
      (proof?.participationPolicy === "COUNTERPARTY_OPTIONAL" &&
        proof.status !== "FINALIZED" &&
        packingAttested));
  const canInvite = Boolean(proof && role === "SELLER" && proof.status !== "FINALIZED");
  const canImportDemoCarrier = proof && role === "SELLER" && Boolean(props.onImportShipmentEvents);
  const canSyncShipment = Boolean(proof?.shipmentSync?.available && props.onSyncShipment);
  const canConnectTrustedDemo =
    proof && role === "SELLER" && !proof.shipmentSync?.available && Boolean(props.onConnectTrustedDemo);

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

  return (
    <main className="page stack">
      <ProofHeader proof={proof} role={role} />
      {props.error ? (
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      ) : null}
      <ProofOverview proof={proof} />
      <ParticipantList proof={proof} />
      {canInvite ? (
        <section className="section stack">
          <h2>Add a participant</h2>
          {!inviteOpen ? (
            <button className="btn" type="button" onClick={() => setInviteOpen(true)}>
              Add participant
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
                                  row.userId === user.userId
                                    ? { ...row, invitationState: "INVITED" }
                                    : row,
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
      <EvidenceList proof={proof} />
      <AttestationList proof={proof} />
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
          <p className="note">Finalization writes the immutable manifest. It cannot be undone.</p>
          <button className="btn" type="button" disabled={props.busy} onClick={props.onFinalize}>
            Finalize Proof
          </button>
        </section>
      ) : null}
      {canImportDemoCarrier ? (
        <section className="section stack">
          <h2>Demo shipment observations</h2>
          <p className="note">
            Imports a reference carrier timeline for this transaction. This is not a live UPS, FedEx,
            USPS, Shippo, or EasyPost connection. Observations may arrive after the core Proof is
            finalized and do not change the core manifest.
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
            Seeds a fake trusted carrier connection for this transaction. It is not UPS, FedEx,
            USPS, Shippo, or EasyPost. Credentials stay on the server.
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
              ? "PackProof asks EasyPost for carrier tracking observations. EasyPost is not the carrier. This client does not send API keys. Test/staging tracking only — not a production EasyPost rollout."
              : "Asks PackProof to refresh observations through the server-side trusted adapter. This client does not send provider credentials or provenance fields."}
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
      <EventTimeline proof={proof} />
      {proof.status === "FINALIZED" ? (
        <ShipmentIntegrityPanel integrity={props.shipmentIntegrity} />
      ) : null}
      <IntegrityPanel proof={proof} />
    </main>
  );
}
