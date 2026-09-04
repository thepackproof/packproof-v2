import { useEffect, useRef, useState } from "react";
import { inviteParticipantHint, inviteParticipantTitle } from "@packproof/copy/custody";
import type { CanonicalProof, PublicProfileView } from "../api/types";
import { EmailProofTrackerShare } from "../components/EmailProofTrackerShare";
import { PageHeader } from "../components/PageHeader";
import { invitationStateLabel, profileInitials } from "../format";

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_LENGTH = 2;

export function InviteScreen(props: {
  proof: CanonicalProof | null;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onSearchUsers: (query: string) => Promise<PublicProfileView[]>;
  onInvite: (input: { inviteeUserId: string }) => Promise<void>;
  onShare?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PublicProfileView[]>([]);
  const [searchStatus, setSearchStatus] = useState<"idle" | "loading" | "empty" | "ready" | "error">("idle");
  const searchGeneration = useRef(0);
  const proof = props.proof;

  useEffect(() => {
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
  }, [query, props.onSearchUsers]);

  return (
    <main className="page stack">
      <PageHeader title={inviteParticipantTitle(proof?.workflowType)} onBack={props.onBack} />
      <p className="note">{inviteParticipantHint(proof?.workflowType)}</p>
      {props.error ? (
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      ) : null}

      <section className="section stack" aria-labelledby="packproof-user-invite-title">
        <div>
          <h2 id="packproof-user-invite-title">Invite a PackProof user</h2>
          <p className="note">Add an existing PackProof user as a participant in this Proof.</p>
        </div>
        <label className="field">
          <span>Search PackProof username</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        {searchStatus === "idle" ? (
          <p className="meta">Enter at least two characters to find a PackProof user.</p>
        ) : null}
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
      </section>

      {proof ? <EmailProofTrackerShare proofId={proof.proofId} disabled={props.busy} /> : null}

      {props.onShare ? (
        <section className="section stack">
          <div>
            <h2>Share another way</h2>
            <p className="note">Copy the standard PackProof invite message for another app.</p>
          </div>
          <button className="btn btn-secondary" type="button" disabled={props.busy} onClick={props.onShare}>
            Share invite
          </button>
        </section>
      ) : null}
    </main>
  );
}
