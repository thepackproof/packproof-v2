import { CARRIER_DISCLOSURE, SOURCE_DISCLOSURE } from "@packproof/copy/errors";
import { chronologyCategoryLabel } from "@packproof/copy/chronology";
import {
  formatDate,
  moneyLabel,
  orderReferenceLabel,
  quantityLabel,
  shippingSummary,
  trackingEnding,
} from "@packproof/copy/format";
import { participantFacingRole } from "@packproof/copy/custody";
import { humanProofStatus, integrityState, sourceLabel } from "@packproof/copy/status";
import type { CanonicalProof, ChronologyEntry, ShipmentIntegrityView } from "../api/types";
import {
  attestationLabel,
  displayValue,
  externalFieldLabel,
  factLabel,
  formatWhen,
} from "../format";
import { CopyableId } from "./CopyableId";
import { TrustBadge } from "./TrustBadge";

export function ProofHeader(props: { proof: CanonicalProof; role?: string }) {
  const title = props.proof.transaction.itemTitle?.trim() || "Untitled item";
  const status = humanProofStatus({
    proofStatus: props.proof.status,
    latestShipmentEventType: props.proof.shipmentObservations?.latest?.eventType,
  });
  const integrity = integrityState({
    proofStatus: props.proof.status,
    committedEvidenceCount: props.proof.evidence.filter((item) => item.validationStatus === "COMMITTED").length,
  });
  const shipping = shippingSummary(props.proof.transaction.shipping ?? {});
  return (
    <header className="header-block">
      <p className="kicker">Proof record</p>
      <h1>{title}</h1>
      <div className="row">
        <span
          className={
            integrity === "finalized" || integrity === "secured"
              ? "status-badge status-badge-success"
              : "status-badge"
          }
        >
          {status}
        </span>
        {integrity !== "none" ? (
          <span className="integrity-mark">
            {integrity === "finalized" ? "Sealed record" : "Evidence secured"}
          </span>
        ) : null}
        {props.role ? (
          <span className="meta">You are the {participantFacingRole(props.proof.workflowType, props.role)}</span>
        ) : null}
      </div>
      <div className="row meta">
        <span>
          {orderReferenceLabel(props.proof.transaction.externalReference) || "No order reference"}
        </span>
        <span>
          {[shipping, trackingEnding(props.proof.transaction.shipping?.trackingNumber)].filter(Boolean).join(" · ") ||
            "No shipping details"}
        </span>
        <span>Created {formatWhen(props.proof.createdAt)}</span>
      </div>
    </header>
  );
}

export function ProofOverview(props: { proof: CanonicalProof }) {
  const txn = props.proof.transaction;
  const records = props.proof.external?.records ?? [];
  return (
    <section className="section">
      <div className="section-head">
        <h2>Overview</h2>
        <TrustBadge kind="EXTERNAL" />
      </div>
      <p className="note">
        Transaction and shipping details were supplied by a participant or connected source. PackProof
        recorded them; it did not independently verify the listing, order, or shipment contents.
      </p>
      <article className="info-card" style={{ boxShadow: "none", padding: 0, border: 0 }}>
        <p className="card-title">{txn.itemTitle || "Untitled item"}</p>
        {txn.itemDescription ? <p>{txn.itemDescription}</p> : null}
        <p className="meta">
          {[quantityLabel(txn.quantity), moneyLabel(txn.transactionValue, txn.currency)].filter(Boolean).join(" • ")}
        </p>
        {txn.transactionDate ? <p className="meta">{formatDate(txn.transactionDate)}</p> : null}
      </article>
      {txn.provenance ? (
        <p className="note">
          {sourceLabel(txn.provenance.source, txn.provenance.provider)}. This is provenance, not a
          verification level.
        </p>
      ) : null}
      {records.length === 0 ? (
        <p className="empty">No purchase details were supplied.</p>
      ) : (
        <dl className="dl">
          {records
            .filter((record) => record.field !== "transaction.metadata")
            .map((record) => (
              <div key={record.field}>
                <dt>{externalFieldLabel(record.field)}</dt>
                <dd>{displayValue(record.value)}</dd>
              </div>
            ))}
        </dl>
      )}
    </section>
  );
}

export function ParticipantList(props: { proof: CanonicalProof; currentUserId: string }) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>People</h2>
        <TrustBadge kind="FACT" />
      </div>
      <ul className="card-list">
        {props.proof.participants.map((participant) => (
          <li key={participant.participantId} className="info-card" style={{ boxShadow: "none" }}>
            <div className="row">
              <strong>{participantFacingRole(props.proof.workflowType, participant.role)}</strong>
              {participant.userId === props.currentUserId ? <span className="meta">You</span> : null}
            </div>
            <div className="meta">Joined {formatWhen(participant.joinedAt)}</div>
          </li>
        ))}
      </ul>
      {props.proof.invitations?.some((invitation) => invitation.status === "PENDING") ? (
        <div className="note">
          Pending invitations
          <ul>
            {props.proof.invitations
              .filter((invitation) => invitation.status === "PENDING")
              .map((invitation) => (
                <li key={invitation.invitationId}>
                  {invitation.inviteeUserId ? "PackProof account invited" : "Invitation pending"} ·{" "}
                  {formatWhen(invitation.createdAt)}
                </li>
              ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function EvidenceList(props: { proof: CanonicalProof }) {
  const evidence = props.proof.evidence;
  return (
    <section className="section">
      <div className="section-head">
        <h2>Evidence</h2>
        <TrustBadge kind="FACT" />
      </div>
      {evidence.length === 0 ? (
        <p className="empty">No evidence is secured yet. Record the item being packed and sealed.</p>
      ) : (
        <div className="stack">
          {evidence.map((item) => (
            <article key={item.evidenceId}>
              <div className="row">
                <strong>
                  {item.evidenceType === "FULFILLMENT_CAPTURE" || item.evidenceType === "SELLER_EVIDENCE"
                    ? "Seller packing evidence"
                    : item.evidenceType.replaceAll("_", " ")}
                </strong>
                <span className="status-badge status-badge-success">
                  {item.validationStatus === "COMMITTED" ? "Evidence secured" : item.validationStatus.toLowerCase()}
                </span>
              </div>
              <dl className="dl">
                <div>
                  <dt>Record created</dt>
                  <dd>{formatWhen(item.createdAt)}</dd>
                </div>
                <div>
                  <dt>Committed</dt>
                  <dd>{formatWhen(item.committedAt)}</dd>
                </div>
                <div>
                  <dt>Evidence digest</dt>
                  <dd>
                    {item.digest?.sha256 || item.sha256 ? (
                      <>
                        <div className="digest">{item.digest?.sha256 ?? item.sha256}</div>
                        <p className="note">
                          SHA-256 committed when this evidence was submitted. PackProof recorded the
                          digest; it does not judge what the media depicts.
                        </p>
                      </>
                    ) : (
                      "Not yet committed"
                    )}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function AttestationList(props: { proof: CanonicalProof }) {
  const attestations = props.proof.attestations ?? [];
  return (
    <section className="section">
      <div className="section-head">
        <h2>Attestations</h2>
        <TrustBadge kind="ATTESTATION" />
      </div>
      <p className="note">Participant statement recorded by PackProof. Not an independently verified fact.</p>
      {attestations.length === 0 ? (
        <p className="empty">No attestations have been recorded.</p>
      ) : (
        <ul className="card-list">
          {attestations.map((attestation) => (
            <li key={attestation.attestationId}>
              <div className="row">
                <TrustBadge kind="ATTESTATION" />
                <span className="meta">Participant statement</span>
              </div>
              <p>{attestationLabel(attestation.statement)}</p>
              <div className="meta">Recorded by PackProof on {formatWhen(attestation.createdAt)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function EventTimeline(props: {
  proof: CanonicalProof;
  onSelect?: (entry: ChronologyEntry) => void;
}) {
  const entries = props.proof.chronology ?? [];
  const finalizedAt = props.proof.finalizedAt;
  let sawCoreFinalized = false;
  return (
    <section className="section">
      <h2>Proof record</h2>
      <p className="note">{SOURCE_DISCLOSURE}</p>
      {props.proof.status === "FINALIZED" && props.proof.integrity?.manifestSha256 ? (
        <p className="note chronology-frozen-note">
          Core PackProof was frozen at {formatWhen(finalizedAt)}. Later shipment observations are
          recorded separately and did not change manifest digest{" "}
          <span className="digest">{props.proof.integrity.manifestSha256}</span>.
        </p>
      ) : null}
      {entries.length === 0 ? (
        <p className="empty">No chronology is available on this Proof.</p>
      ) : (
        <ol className="timeline">
          {entries.map((entry) => {
            const isCoreFinalized = entry.eventType === "PROOF_FINALIZED";
            if (isCoreFinalized) {
              sawCoreFinalized = true;
            }
            const afterCore = sawCoreFinalized && !isCoreFinalized && entry.category === "SHIPMENT";
            const className = [
              `chronology-${entry.category.toLowerCase()}`,
              isCoreFinalized ? "chronology-core" : "",
              afterCore ? "chronology-after-core" : "",
            ]
              .filter(Boolean)
              .join(" ");
            const body = (
              <>
                <div className="row">
                  <strong>{entry.title}</strong>
                  <span className={`badge badge-chronology badge-chronology-${entry.category.toLowerCase()}`}>
                    {chronologyCategoryLabel(entry.category, entry.source, entry.provider)}
                  </span>
                </div>
                {entry.description ? <span>{entry.description}</span> : null}
                <span className="meta">{formatWhen(entry.occurredAt)}</span>
              </>
            );
            return (
              <li key={entry.id} className={className}>
                {props.onSelect ? (
                  <button type="button" className="timeline-event" onClick={() => props.onSelect?.(entry)}>
                    {body}
                  </button>
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function IntegrityPanel(props: { proof: CanonicalProof }) {
  const facts = props.proof.facts ?? [];
  return (
    <section className="section">
      <div className="section-head">
        <h2>Integrity</h2>
        <TrustBadge kind="FACT" />
      </div>
      <p className="note">
        These are records PackProof can establish from its own infrastructure: receipt, digest, and
        chronology. Historical committed evidence is immutable. Shipment observations that arrive after
        finalization are not part of this core digest.
      </p>
      <dl className="dl">
        <div>
          <dt>Finalization</dt>
          <dd>{props.proof.status === "FINALIZED" ? "Record completed" : "Not yet finalized"}</dd>
        </div>
        <div>
          <dt>Manifest digest</dt>
          <dd className="digest">{props.proof.integrity?.manifestSha256 ?? "—"}</dd>
        </div>
      </dl>
      <ul className="card-list">
        {facts.map((fact, index) => (
          <li key={`${fact.name}-${index}`}>
            <div className="row">
              <TrustBadge kind="FACT" />
              <strong>{factLabel(fact.name)}</strong>
            </div>
            <div className="meta">{formatWhen(fact.at)}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ShipmentIntegrityPanel(props: { integrity: ShipmentIntegrityView | null }) {
  const integrity = props.integrity;
  if (!integrity || integrity.status === "CORE_NOT_FINALIZED") {
    return null;
  }
  if (integrity.status === "NO_SHIPMENT") {
    return (
      <section className="section">
        <div className="section-head">
          <h2>Shipment record</h2>
          <TrustBadge kind="FACT" />
        </div>
        <p className="note">
          No shipment identity is associated with this Proof. PackProof did not invent a shipment
          record.
        </p>
      </section>
    );
  }
  const checks = integrity.verification;
  const failed = !checks.valid;
  return (
    <section className="section">
      <div className="section-head">
        <h2>Shipment record</h2>
        <TrustBadge kind="FACT" />
      </div>
      <p className="note">
        This checks that PackProof’s stored shipment observations still hash to the frozen core record.
        It does not verify that a carrier’s real-world statement is true.
      </p>
      {failed ? (
        <p className="banner banner-error" role="alert">
          Shipment record integrity check failed. The stored hashes do not recompute to a consistent
          supplement.
        </p>
      ) : null}
      <p>
        {integrity.eventCount} shipment observation{integrity.eventCount === 1 ? "" : "s"}
      </p>
      <ul className="card-list">
        <li>
          {checks.linkedToFinalizedProof
            ? "✓ Linked to finalized PackProof"
            : "Not linked to a finalized PackProof"}
        </li>
        <li>{checks.eventChainValid ? "✓ Shipment event chain valid" : "Shipment event chain invalid"}</li>
        <li>
          {checks.supplementValid ? "✓ Shipment record digest valid" : "Shipment record digest invalid"}
        </li>
      </ul>
      <p className="note">{CARRIER_DISCLOSURE}</p>
      <dl className="dl">
        <div>
          <dt>Shipment record SHA-256</dt>
          <dd className="digest">{integrity.shipmentSupplementSha256 ?? "—"}</dd>
        </div>
      </dl>
    </section>
  );
}

export function TechnicalDetails(props: { proof: CanonicalProof }) {
  return (
    <details className="technical-details section">
      <summary>Technical details</summary>
      <p className="note">Identifiers and digests for inspection. They are not needed for normal use.</p>
      <dl className="dl">
        <div>
          <dt>Proof ID</dt>
          <dd>
            <CopyableId value={props.proof.proofId} label="Proof ID" />
          </dd>
        </div>
        <div>
          <dt>Transaction ID</dt>
          <dd>
            <CopyableId value={props.proof.transactionId} label="transaction ID" />
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{props.proof.status}</dd>
        </div>
      </dl>
      <IntegrityPanel proof={props.proof} />
    </details>
  );
}
