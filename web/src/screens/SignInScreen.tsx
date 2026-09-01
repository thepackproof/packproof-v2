import { useState, type FormEvent } from "react";
import { PackProofApi } from "../api/client";
import { ApiError } from "../api/types";
import { cognitoSignIn, defaultCognitoConfig, formatCognitoError } from "../auth/cognito";
import { defaultApiBaseUrl, defaultAuthMode, type AuthMode, type WebSession } from "../auth/session";

export function SignInScreen(props: {
  onSignedIn: (session: WebSession) => void;
  onGo: (path: string) => void;
}) {
  const [authMode, setAuthMode] = useState<AuthMode>(defaultAuthMode());
  const [apiBaseUrl, setApiBaseUrl] = useState(defaultApiBaseUrl());
  const [subject, setSubject] = useState("seller-1");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const tokenRef = { current: null as string | null };
    const api = new PackProofApi({
      baseUrl: apiBaseUrl.trim(),
      getToken: () => tokenRef.current,
    });
    try {
      if (authMode === "dev") {
        const login = await api.loginDev(subject.trim());
        tokenRef.current = login.token;
        const me = await api.getMe();
        props.onSignedIn({
          apiBaseUrl: apiBaseUrl.trim(),
          authMode,
          userId: me.userId,
          username: me.username,
          displayName: me.displayName,
          token: login.token,
          refreshToken: null,
          accessExpiresAt: null,
          subject: subject.trim(),
        });
        return;
      }
      const tokens = await cognitoSignIn(defaultCognitoConfig(), {
        email: email.trim(),
        password,
      });
      tokenRef.current = tokens.accessToken;
      const me = await api.getMe();
      props.onSignedIn({
        apiBaseUrl: apiBaseUrl.trim(),
        authMode,
        userId: me.userId,
        username: me.username,
        displayName: me.displayName,
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessExpiresAt: tokens.expiresAt,
        subject: email.trim(),
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : formatCognitoError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page page-narrow">
      <img className="auth-logo" src="/packproof-logo.png" alt="" width={72} height={72} />
      <h1>PackProof</h1>
      <p className="lede">Sign in to view and continue your PackProof records.</p>
      <form className="section stack" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>Authentication</span>
          <select value={authMode} onChange={(event) => setAuthMode(event.target.value as AuthMode)}>
            <option value="dev">Development subject</option>
            <option value="cognito">PackProof account</option>
          </select>
        </label>
        {authMode === "dev" ? (
          <label className="field" htmlFor="dev-subject">
            <span>Development subject</span>
            <input
              id="dev-subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
        ) : (
          <>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
          </>
        )}
        <details className="dev-options">
          <summary>Developer options</summary>
          <label className="field">
            <span>API base URL</span>
            <input
              value={apiBaseUrl}
              onChange={(event) => setApiBaseUrl(event.target.value)}
              placeholder="Empty uses this origin (local proxy)"
            />
          </label>
        </details>
        {error ? (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        ) : null}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
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
