import { useState } from "react";
import { displayName } from "@packproof/copy/format";
import { providerDisplay } from "@packproof/copy/status";
import type { CommerceConnectionView } from "../api/types";

export function AccountScreen(props: {
  displayName: string | null;
  username: string | null;
  subject: string;
  connections: CommerceConnectionView[];
  error: string | null;
  busy: boolean;
  onAcceptInvitation: (invitationId: string) => void;
  onOpenStation: () => void;
  onOpenStores: () => void;
  onSignOut: () => void;
}) {
  const [invitationRef, setInvitationRef] = useState("");
  const name = displayName({
    displayName: props.displayName,
    username: props.username,
    fallback: props.subject,
  });

  return (
    <main className="page stack">
      <h1>Account</h1>
      {props.error ? (
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      ) : null}

      <section className="section">
        <h2 className="card-title">{name}</h2>
        <p className="meta">{props.username ? `@${props.username}` : "Username not set"}</p>
      </section>

      <section className="section stack">
        <h2>Connected marketplaces</h2>
        {props.connections.length === 0 ? (
          <p className="meta">No marketplace connections on this account yet.</p>
        ) : (
          props.connections.map((connection) => (
            <article key={connection.connectionId}>
              <div className="card-title">
                {connection.externalAccountReference === "demo-store-001"
                  ? "Demo Store"
                  : connection.providerDisplay || providerDisplay(connection.provider)}
              </div>
              <p className="meta">{connection.status}</p>
            </article>
          ))
        )}
        <button className="btn btn-secondary" type="button" onClick={props.onOpenStores}>
          Connected stores
        </button>
      </section>

      <section className="section stack">
        <h2>Packing tools</h2>
        <button className="btn btn-secondary" type="button" onClick={props.onOpenStation}>
          Packing Station
        </button>
      </section>

      <section className="section">
        <h2>About PackProof</h2>
        <p className="note">
          PackProof creates tamper-evident records for commerce. It records what was submitted, when,
          and by whom. It does not decide who is right.
        </p>
      </section>

      <section className="section stack">
        <h2>Advanced options</h2>
        <p className="note">Use this only if someone sent you an invitation ID.</p>
        <form
          className="invite-accept"
          onSubmit={(event) => {
            event.preventDefault();
            const value = invitationRef.trim();
            if (value) {
              props.onAcceptInvitation(value);
              setInvitationRef("");
            }
          }}
        >
          <label className="field" htmlFor="invitation-id">
            <span>Invitation ID</span>
            <input
              id="invitation-id"
              value={invitationRef}
              onChange={(event) => setInvitationRef(event.target.value)}
              autoComplete="off"
            />
          </label>
          <button className="btn" type="submit" disabled={props.busy || !invitationRef.trim()}>
            Accept invitation
          </button>
        </form>
      </section>

      <button className="btn btn-danger" type="button" onClick={props.onSignOut}>
        Sign out
      </button>
    </main>
  );
}
