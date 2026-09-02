import { displayName } from "@packproof/copy/format";
import { ACCOUNT_DELETION_COPY } from "@packproof/copy/legal";
import { providerDisplay } from "@packproof/copy/status";
import type { AppearancePreference } from "@packproof/theme/tokens";
import type { CommerceConnectionView, ConnectedAccountProviderCatalogView, ConnectedAccountView } from "../api/types";
import { PageHeader } from "../components/PageHeader";
import { useTheme } from "../theme/ThemeProvider";
import { ConnectedAccountsPanel } from "./ConnectedAccountsPanel";

const APPEARANCE_OPTIONS: Array<{ id: AppearancePreference; label: string; hint: string }> = [
  { id: "system", label: "System", hint: "Match this device" },
  { id: "light", label: "Light", hint: "Always use light PackProof" },
  { id: "dark", label: "Dark", hint: "Always use dark PackProof" },
];

export function AccountScreen(props: {
  displayName: string | null;
  username: string | null;
  subject: string;
  connections: CommerceConnectionView[];
  connectedAccounts: ConnectedAccountView[];
  connectedProviders: ConnectedAccountProviderCatalogView[];
  connectedNotice: string | null;
  error: string | null;
  busy: boolean;
  displayNameInput: string;
  usernameInput: string;
  onDisplayNameChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onSaveProfile: () => void;
  onOpenStation: () => void;
  onOpenStores: () => void;
  onOpenFulfillment: () => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
  onConnectAccount: (provider: string, extra?: { shop?: string }) => void;
  onReauthorizeAccount: (accountId: string) => void;
  onDisconnectAccount: (accountId: string) => void;
  onBack: () => void;
  onSignOut: () => void;
}) {
  const theme = useTheme();
  const name = displayName({
    displayName: props.displayName,
    username: props.username,
    fallback: props.subject,
  });

  return (
    <main className="page stack">
      <PageHeader title="Account" onBack={props.onBack} />
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
        <h2>Profile</h2>
        {!props.username ? (
          <label className="field">
            <span>Username</span>
            <input
              value={props.usernameInput}
              onChange={(event) => props.onUsernameChange(event.target.value)}
              autoComplete="username"
            />
          </label>
        ) : null}
        <label className="field">
          <span>Display name</span>
          <input
            value={props.displayNameInput}
            onChange={(event) => props.onDisplayNameChange(event.target.value)}
            autoComplete="name"
          />
        </label>
        <button className="btn" type="button" disabled={props.busy} onClick={props.onSaveProfile}>
          {props.username ? "Update display name" : "Save profile"}
        </button>
      </section>

      <section className="section stack">
        <h2>Appearance</h2>
        <div className="appearance-list" role="radiogroup" aria-label="Appearance">
          {APPEARANCE_OPTIONS.map((option) => {
            const selected = theme.preference === option.id;
            return (
              <button
                key={option.id}
                type="button"
                className={`appearance-row${selected ? " appearance-row-selected" : ""}`}
                role="radio"
                aria-checked={selected}
                onClick={() => theme.setPreference(option.id)}
              >
                <span>
                  <strong className="card-title">{option.label}</strong>
                  <span className="meta" style={{ display: "block" }}>
                    {option.hint}
                  </span>
                </span>
                <span className={`radio${selected ? " radio-on" : ""}`} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </section>

      <ConnectedAccountsPanel
        accounts={props.connectedAccounts}
        providers={props.connectedProviders}
        notice={props.connectedNotice}
        busy={props.busy}
        onConnect={props.onConnectAccount}
        onReauthorize={props.onReauthorizeAccount}
        onDisconnect={props.onDisconnectAccount}
      />

      <section className="section stack">
        <h2>Connected marketplaces</h2>
        {props.connections.length === 0 ? (
          <p className="meta">
            No marketplace connections on this account yet. Connect eBay or Shopify from Connected Accounts above.
          </p>
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
        <button className="btn btn-secondary" type="button" onClick={props.onOpenFulfillment}>
          Fulfillment
        </button>
      </section>

      <section className="section stack">
        <h2>About PackProof</h2>
        <p className="note">
          PackProof creates tamper-evident records for commerce. It records what was submitted, when, and by whom. It
          does not decide who is right.
        </p>
        <button className="btn btn-tertiary" type="button" onClick={props.onOpenTerms}>
          Terms of Service
        </button>
        <button className="btn btn-tertiary" type="button" onClick={props.onOpenPrivacy}>
          Privacy Policy
        </button>
      </section>

      <section className="section stack">
        <h2>Account deletion</h2>
        <p className="note">{ACCOUNT_DELETION_COPY}</p>
        <button className="btn btn-secondary" type="button" onClick={props.onOpenPrivacy}>
          Open Privacy Policy
        </button>
      </section>

      <button className="btn btn-danger" type="button" onClick={props.onSignOut}>
        Sign out
      </button>
    </main>
  );
}
