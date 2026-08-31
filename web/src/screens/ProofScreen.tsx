import { useState } from "react";
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

export function ProofScreen(props: {
  proof: CanonicalProof | null;
  shipmentIntegrity: ShipmentIntegrityView | null;
  currentUserId: string;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onInvite: (input: { inviteeUserId?: string; inviteeIdentifier?: string }) => void;
  onAttest: (statement: string) => void;
  onFinalize: () => void;
  onImportShipmentEvents?: (throughEventType?: string) => void;
  onSyncShipment?: () => void;
  onConnectTrustedDemo?: () => void;
  onSearchUsers: (query: string) => Promise<PublicProfileView[]>;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PublicProfileView[]>([]);
  const [invitee, setInvitee] = useState("");
  const proof = props.proof;
  const role = proof?.participants.find((participant) => participant.userId === props.currentUserId)
    ?.role;
  const canAttest = proof && proof.status !== "FINALIZED" && Boolean(role);
  const canFinalize = proof?.status === "EVIDENCE_COMMITTED" && role === "SELLER";
  const canInvite =
    proof && role === "SELLER" && proof.status !== "FINALIZED";
  const canImportDemoCarrier = proof && role === "SELLER" && Boolean(props.onImportShipmentEvents);
  const canSyncShipment = Boolean(proof?.shipmentSync?.available && props.onSyncShipment);
  const canConnectTrustedDemo =
    proof && role === "SELLER" && !proof.shipmentSync?.available && Boolean(props.onConnectTrustedDemo);

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
          <h2>Invite a participant</h2>
          <p className="note">
            Search finds PackProof accounts that already have a username. An identifier invitation
            can be accepted with the invitation ID. Invitation tokens are never shown here.
          </p>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void props
                .onSearchUsers(query)
                .then((users) => setResults(users))
                .catch(() => setResults([]));
            }}
          >
            <label className="field">
              <span>Search PackProof users</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button className="btn btn-secondary" type="submit">
              Search
            </button>
          </form>
          {results.map((user) => (
            <button
              key={user.userId}
              className="btn btn-secondary"
              type="button"
              onClick={() => props.onInvite({ inviteeUserId: user.userId })}
            >
              Invite {user.displayName || user.username}
            </button>
          ))}
          <label className="field">
            <span>Or invite by identifier</span>
            <input value={invitee} onChange={(event) => setInvitee(event.target.value)} />
          </label>
          <button
            className="btn"
            type="button"
            disabled={props.busy || !invitee.trim()}
            onClick={() => props.onInvite({ inviteeIdentifier: invitee.trim() })}
          >
            Send invitation
          </button>
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
            onClick={() => props.onConnectTrustedDemo?.()}
          >
            Connect trusted demo
          </button>
        </section>
      ) : null}
      {canSyncShipment ? (
        <section className="section stack">
          <h2>Trusted shipment sync</h2>
          <p className="note">
            Asks PackProof to refresh observations through the server-side trusted adapter. This
            client does not send provider credentials or provenance fields.
          </p>
          <button
            className="btn"
            type="button"
            disabled={props.busy}
            onClick={() => props.onSyncShipment?.()}
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
