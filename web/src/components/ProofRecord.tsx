import type { CanonicalProof } from "../api/types";
import {
  attestationLabel,
  displayValue,
  eventLabel,
  externalFieldLabel,
  factLabel,
  formatWhen,
  lifecycleLabel,
  statusLabel,
} from "../format";
import { CopyableId } from "./CopyableId";
import { TrustBadge } from "./TrustBadge";

export function ProofHeader(props: { proof: CanonicalProof; role?: string }) {
  return (
    <header className="header-block">
      <div className="row">
        <span className="badge badge-state">{lifecycleLabel(props.proof.status)}</span>
        <TrustBadge kind="FACT" />
        {props.role ? <span className="meta">You are the {props.role.toLowerCase()}</span> : null}
      </div>
      <h1>Proof record</h1>
      <p className="lede">
        A PackProof record of what this system received, hashed, and preserved. It does not decide
        fraud, ownership, authenticity, or claim outcome.
      </p>
      <div className="row meta">
        <CopyableId value={props.proof.proofId} label="Proof ID" />
        <span>{statusLabel(props.proof.status)}</span>
        <span>Created {formatWhen(props.proof.createdAt)}</span>
        {props.proof.finalizedAt ? (
          <span>Finalized {formatWhen(props.proof.finalizedAt)}</span>
        ) : null}
      </div>
    </header>
  );
}

export function ProofOverview(props: { proof: CanonicalProof }) {
  const records = props.proof.external?.records ?? [];
  return (
    <section className="section">
      <div className="section-head">
        <h2>Overview</h2>
        <TrustBadge kind="EXTERNAL" />
      </div>
      <p className="note">
        Transaction and shipping details were supplied by a participant or connected source.
        PackProof recorded them; it did not independently verify the listing, order, or shipment
        contents.
      </p>
      {props.proof.transaction.provenance ? (
        <p className="note">
          Imported from {props.proof.transaction.provenance.provider} (
          {props.proof.transaction.provenance.source}). This is provenance, not a verification
          level.
        </p>
      ) : null}
      {records.length === 0 ? (
        <p className="empty">No external transaction details were supplied.</p>
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
      {props.proof.external?.references?.length ? (
        <p className="note">
          Bound identity{" "}
          <code className="mono">
            {props.proof.external.references[0].tenantKey} +{" "}
            {props.proof.external.references[0].externalTransactionId}
          </code>
          . This identity mapping is not changed by later edits to the display reference.
        </p>
      ) : null}
    </section>
  );
}

export function ParticipantList(props: { proof: CanonicalProof }) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>Participants</h2>
        <TrustBadge kind="FACT" />
      </div>
      <ul className="card-list">
        {props.proof.participants.map((participant) => (
          <li key={participant.participantId} className="section" style={{ padding: "0.85rem 1rem" }}>
            <div className="row">
              <strong>{participant.role.toLowerCase()}</strong>
              <span className="meta">{participant.invitationState ?? participant.status}</span>
            </div>
            <CopyableId value={participant.userId} label="user ID" />
            <div className="meta">Joined {formatWhen(participant.joinedAt)}</div>
          </li>
        ))}
      </ul>
      {props.proof.invitations?.some((invitation) => invitation.status === "PENDING") ? (
        <div className="note">
          Pending invitations are recorded without showing invitation secrets.
          <ul>
            {props.proof.invitations
              .filter((invitation) => invitation.status === "PENDING")
              .map((invitation) => (
                <li key={invitation.invitationId}>
                  {invitation.inviteeIdentifier} · invited {formatWhen(invitation.createdAt)}
                  <div>
                    <CopyableId value={invitation.invitationId} label="invitation ID" />
                  </div>
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
        <p className="empty">
          No evidence is committed yet. Capture remains on the mobile client. This page shows the
          digest and timestamps after the server accepts the object.
        </p>
      ) : (
        <div className="stack">
          {evidence.map((item) => (
            <article key={item.evidenceId}>
              <div className="row">
                <strong>{item.evidenceType.replaceAll("_", " ")}</strong>
                <span className="badge badge-state">{item.validationStatus.toLowerCase()}</span>
              </div>
              <dl className="dl">
                <div>
                  <dt>Submitter</dt>
                  <dd>
                    {item.submittedBy ? (
                      <CopyableId value={item.submittedBy} label="submitter" />
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
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
                          SHA-256 committed when this evidence was submitted. PackProof recorded
                          the digest; it does not judge what the media depicts.
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
              <div className="meta">
                Recorded by PackProof on {formatWhen(attestation.createdAt)}
              </div>
              <CopyableId value={attestation.attestedBy} label="attested by" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function EventTimeline(props: { proof: CanonicalProof }) {
  const events = props.proof.events ?? [];
  return (
    <section className="section">
      <div className="section-head">
        <h2>History</h2>
        <TrustBadge kind="FACT" />
      </div>
      {events.length === 0 ? (
        <p className="empty">No events are available on this Proof.</p>
      ) : (
        <ol className="timeline">
          {events.map((event) => (
            <li key={event.eventId}>
              <strong>{eventLabel(event.eventType)}</strong>
              <span className="meta">{formatWhen(event.at)}</span>
            </li>
          ))}
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
        chronology. Historical committed evidence is immutable.
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
