import { useState, type FormEvent } from "react";
import { PackProofApi } from "../api/client";
import { ApiError } from "../api/types";
import type { WebSession } from "../auth/session";

export function ProfileSetupScreen(props: {
  session: WebSession;
  onCompleted: (profile: { username: string | null; displayName: string | null }) => void;
  onSignOut: () => void;
  onGo: (path: string) => void;
}) {
  const needsUsername = !props.session.username;
  const needsDisplayName = !props.session.displayName;
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setUsernameError(null);
    setDisplayNameError(null);
    const api = new PackProofApi({
      baseUrl: props.session.apiBaseUrl,
      getToken: () => props.session.token,
    });
    try {
      const updated = await api.updateProfile({
        ...(needsUsername ? { username: username.trim() } : {}),
        ...(needsDisplayName ? { displayName: displayName.trim() } : {}),
      });
      props.onCompleted({
        username: updated.username,
        displayName: updated.displayName,
      });
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.code === "USERNAME_TAKEN") {
          setUsernameError("That PackProof username is already taken. Try another.");
          return;
        }
        if (caught.code === "INVALID_USERNAME") {
          setUsernameError(
            "Use 3–24 characters. Start with a letter. Letters, numbers, periods and underscores are allowed.",
          );
          return;
        }
        if (caught.code === "INVALID_DISPLAY_NAME") {
          setDisplayNameError("Enter a display name other people can recognize.");
          return;
        }
        setError(caught.message);
        return;
      }
      setError(caught instanceof Error ? caught.message : "We could not save your profile.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page page-narrow">
      <img className="auth-logo" src="/packproof-logo.png" alt="" width={72} height={72} />
      <h1>Finish setting up your account</h1>
      <p className="lede">Choose how you appear to other PackProof users.</p>
      <form className="section stack" onSubmit={(event) => void submit(event)}>
        {needsUsername ? (
          <div className="field">
            <label htmlFor="profile-username">PackProof username</label>
            <input
              id="profile-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              spellCheck={false}
              aria-invalid={usernameError ? true : undefined}
              aria-describedby="profile-username-help profile-username-immutable"
              required
            />
            <p id="profile-username-help" className="field-help">
              3–24 characters. Start with a letter. Letters, numbers, periods and underscores are
              allowed.
            </p>
            <p id="profile-username-immutable" className="field-help">
              Your PackProof username cannot be changed after you choose it.
            </p>
            {usernameError ? (
              <p className="field-error" role="alert">
                {usernameError}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="meta">
            PackProof username <strong>@{props.session.username}</strong>
          </p>
        )}
        {needsDisplayName ? (
          <div className="field">
            <label htmlFor="profile-display-name">Display name</label>
            <input
              id="profile-display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="name"
              aria-invalid={displayNameError ? true : undefined}
              aria-describedby="profile-display-name-help"
              required
            />
            <p id="profile-display-name-help" className="field-help">
              This is the name other PackProof users will see.
            </p>
            {displayNameError ? (
              <p className="field-error" role="alert">
                {displayNameError}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="meta">Display name {props.session.displayName}</p>
        )}
        {error ? (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        ) : null}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Finishing setup…" : "Finish setup"}
        </button>
        <p className="auth-alt">
          <button type="button" className="link-button" onClick={props.onSignOut}>
            Sign out
          </button>
        </p>
      </form>
      <nav className="auth-legal-links" aria-label="Legal">
        <a
          href="/new/privacy"
          onClick={(event) => {
            event.preventDefault();
            props.onGo("/new/privacy");
          }}
        >
          Privacy Policy
        </a>
        <a
          href="/new/terms"
          onClick={(event) => {
            event.preventDefault();
            props.onGo("/new/terms");
          }}
        >
          Terms of Service
        </a>
      </nav>
    </main>
  );
}
