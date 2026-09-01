import { useRef, useState, type FormEvent } from "react";
import { PackProofApi } from "../api/client";
import { ApiError } from "../api/types";
import {
  CognitoAuthError,
  cognitoConfirmSignUp,
  cognitoResendConfirmationCode,
  cognitoSignIn,
  cognitoSignUp,
  defaultCognitoConfig,
  formatCognitoError,
  normalizeEmail,
} from "../auth/cognito";
import {
  defaultApiBaseUrl,
  isDevAuthAvailable,
  type AuthMode,
  type WebSession,
} from "../auth/session";

type AuthView = "sign-in" | "create-account" | "confirm-account" | "verified";

export function SignInScreen(props: {
  onSignedIn: (session: WebSession) => void;
  onGo: (path: string) => void;
}) {
  const allowDevAuth = isDevAuthAvailable();
  const [view, setView] = useState<AuthView>("sign-in");
  const [apiBaseUrl, setApiBaseUrl] = useState(defaultApiBaseUrl());
  const [useDevAuth, setUseDevAuth] = useState(false);
  const [subject, setSubject] = useState("seller-1");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirmationCode, setConfirmationCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const pendingPasswordRef = useRef<string | null>(null);

  function clearSecrets() {
    pendingPasswordRef.current = null;
    setPassword("");
    setConfirmPassword("");
    setConfirmationCode("");
  }

  function goTo(next: AuthView) {
    setError(null);
    setInfo(null);
    setView(next);
    if (next === "sign-in" || next === "create-account") {
      setConfirmationCode("");
    }
    if (next === "sign-in") {
      pendingPasswordRef.current = null;
      setConfirmPassword("");
    }
  }

  async function establishCognitoSession(input: { email: string; password: string }): Promise<void> {
    const tokenRef = { current: null as string | null };
    const api = new PackProofApi({
      baseUrl: apiBaseUrl.trim(),
      getToken: () => tokenRef.current,
    });
    const tokens = await cognitoSignIn(defaultCognitoConfig(), input);
    tokenRef.current = tokens.accessToken;
    const me = await api.getMe();
    props.onSignedIn({
      apiBaseUrl: apiBaseUrl.trim(),
      authMode: "cognito",
      userId: me.userId,
      username: me.username,
      displayName: me.displayName,
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: tokens.expiresAt,
      subject: input.email,
    });
  }

  async function submitSignIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (allowDevAuth && useDevAuth) {
        const tokenRef = { current: null as string | null };
        const api = new PackProofApi({
          baseUrl: apiBaseUrl.trim(),
          getToken: () => tokenRef.current,
        });
        const login = await api.loginDev(subject.trim());
        tokenRef.current = login.token;
        const me = await api.getMe();
        props.onSignedIn({
          apiBaseUrl: apiBaseUrl.trim(),
          authMode: "dev" satisfies AuthMode,
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
      const normalized = normalizeEmail(email);
      try {
        await establishCognitoSession({ email: normalized, password });
        clearSecrets();
      } catch (caught) {
        if (caught instanceof CognitoAuthError && caught.code === "UserNotConfirmedException") {
          pendingPasswordRef.current = password;
          setEmail(normalized);
          setConfirmationCode("");
          setView("confirm-account");
          setError(null);
          setInfo("This email is not verified yet. Enter the verification code we sent.");
          return;
        }
        throw caught;
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : formatCognitoError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitCreateAccount(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setInfo(null);
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const normalized = normalizeEmail(email);
      const result = await cognitoSignUp(defaultCognitoConfig(), {
        email: normalized,
        password,
      });
      setEmail(result.email);
      pendingPasswordRef.current = password;
      setConfirmPassword("");
      setConfirmationCode("");
      if (result.userConfirmed) {
        await establishCognitoSession({ email: result.email, password });
        clearSecrets();
        return;
      }
      setView("confirm-account");
    } catch (caught) {
      setError(formatCognitoError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitConfirmation(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    const normalized = normalizeEmail(email);
    const code = confirmationCode.trim();
    try {
      await cognitoConfirmSignUp(defaultCognitoConfig(), {
        email: normalized,
        confirmationCode: code,
      });
      setConfirmationCode("");
      const retained = pendingPasswordRef.current;
      pendingPasswordRef.current = null;
      if (!retained) {
        setPassword("");
        setView("verified");
        return;
      }
      try {
        await establishCognitoSession({ email: normalized, password: retained });
        clearSecrets();
      } catch {
        setPassword("");
        setView("verified");
      }
    } catch (caught) {
      setError(formatCognitoError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await cognitoResendConfirmationCode(defaultCognitoConfig(), { email });
      setInfo("A new verification code was sent.");
    } catch (caught) {
      setError(formatCognitoError(caught));
    } finally {
      setBusy(false);
    }
  }

  function useDifferentEmail() {
    clearSecrets();
    goTo("create-account");
  }

  return (
    <main className="page page-narrow">
      <img className="auth-logo" src="/packproof-logo.png" alt="" width={72} height={72} />
      {view === "confirm-account" ? (
        <>
          <h1>Check your email</h1>
          <p className="lede">We sent a verification code to {normalizeEmail(email)}.</p>
        </>
      ) : view === "verified" ? (
        <>
          <h1>Account verified</h1>
          <p className="lede">Sign in with your email and password to continue.</p>
        </>
      ) : view === "create-account" ? (
        <>
          <h1>PackProof</h1>
          <p className="lede">Create an account to start a PackProof record.</p>
        </>
      ) : (
        <>
          <h1>PackProof</h1>
          <p className="lede">Sign in to view and continue your PackProof records.</p>
        </>
      )}

      {view === "sign-in" || view === "create-account" ? (
        <div className="auth-switch" role="tablist" aria-label="Account">
          <button
            type="button"
            role="tab"
            aria-selected={view === "sign-in"}
            onClick={() => goTo("sign-in")}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "create-account"}
            onClick={() => goTo("create-account")}
          >
            Create account
          </button>
        </div>
      ) : null}

      {view === "sign-in" ? (
        <form className="section stack" onSubmit={(event) => void submitSignIn(event)}>
          {allowDevAuth && useDevAuth ? (
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
              <label className="field" htmlFor="sign-in-email">
                <span>Email</span>
                <input
                  id="sign-in-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value.trim())}
                  autoComplete="email"
                  required
                />
              </label>
              <label className="field" htmlFor="sign-in-password">
                <span>Password</span>
                <input
                  id="sign-in-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
            </>
          )}
          <DeveloperOptions
            allowDevAuth={allowDevAuth}
            useDevAuth={useDevAuth}
            onUseDevAuth={setUseDevAuth}
            apiBaseUrl={apiBaseUrl}
            onApiBaseUrl={setApiBaseUrl}
          />
          {error ? (
            <div className="banner banner-error" role="alert">
              {error}
            </div>
          ) : null}
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          {!useDevAuth ? (
            <p className="auth-alt">
              Need an account?{" "}
              <button type="button" className="link-button" onClick={() => goTo("create-account")}>
                Create account
              </button>
            </p>
          ) : null}
        </form>
      ) : null}

      {view === "create-account" ? (
        <form className="section stack" onSubmit={(event) => void submitCreateAccount(event)}>
          <label className="field" htmlFor="create-email">
            <span>Email</span>
            <input
              id="create-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value.trim())}
              autoComplete="email"
              required
            />
          </label>
          <label className="field" htmlFor="create-password">
            <span>Password</span>
            <input
              id="create-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
          <label className="field" htmlFor="create-password-confirm">
            <span>Confirm password</span>
            <input
              id="create-password-confirm"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
          <p className="auth-legal-note">
            By creating an account, you agree to the PackProof{" "}
            <a
              href="/new/terms"
              onClick={(event) => {
                event.preventDefault();
                props.onGo("/new/terms");
              }}
            >
              Terms of Service
            </a>{" "}
            and acknowledge the{" "}
            <a
              href="/new/privacy"
              onClick={(event) => {
                event.preventDefault();
                props.onGo("/new/privacy");
              }}
            >
              Privacy Policy
            </a>
            .
          </p>
          {error ? (
            <div className="banner banner-error" role="alert">
              {error}
            </div>
          ) : null}
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Creating account…" : "Create account"}
          </button>
          <p className="auth-alt">
            Already have an account?{" "}
            <button type="button" className="link-button" onClick={() => goTo("sign-in")}>
              Sign in
            </button>
          </p>
        </form>
      ) : null}

      {view === "confirm-account" ? (
        <form className="section stack" onSubmit={(event) => void submitConfirmation(event)}>
          <label className="field" htmlFor="verification-code">
            <span>Verification code</span>
            <input
              id="verification-code"
              value={confirmationCode}
              onChange={(event) => setConfirmationCode(event.target.value)}
              autoComplete="one-time-code"
              inputMode="numeric"
              required
            />
          </label>
          {info ? <div className="banner banner-info">{info}</div> : null}
          {error ? (
            <div className="banner banner-error" role="alert">
              {error}
            </div>
          ) : null}
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Verifying…" : "Verify account"}
          </button>
          <div className="btn-row">
            <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void resendCode()}>
              Resend code
            </button>
          </div>
          <p className="auth-alt">
            <button type="button" className="link-button" onClick={useDifferentEmail}>
              Use a different email
            </button>
          </p>
        </form>
      ) : null}

      {view === "verified" ? (
        <div className="section stack">
          {error ? (
            <div className="banner banner-error" role="alert">
              {error}
            </div>
          ) : null}
          <button className="btn" type="button" onClick={() => goTo("sign-in")}>
            Sign in
          </button>
        </div>
      ) : null}

      <AuthLegalLinks onGo={props.onGo} />
    </main>
  );
}

function DeveloperOptions(props: {
  allowDevAuth: boolean;
  useDevAuth: boolean;
  onUseDevAuth: (value: boolean) => void;
  apiBaseUrl: string;
  onApiBaseUrl: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="dev-options"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
        Developer options
      </summary>
      {props.allowDevAuth ? (
        <label className="field-check">
          <input
            type="checkbox"
            checked={props.useDevAuth}
            onChange={(event) => props.onUseDevAuth(event.target.checked)}
          />
          <span>Use development subject</span>
        </label>
      ) : null}
      <label className="field">
        <span>API base URL</span>
        <input
          value={props.apiBaseUrl}
          onChange={(event) => props.onApiBaseUrl(event.target.value)}
          placeholder="Empty uses this origin (local proxy)"
        />
      </label>
    </details>
  );
}

function AuthLegalLinks(props: { onGo: (path: string) => void }) {
  return (
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
  );
}
