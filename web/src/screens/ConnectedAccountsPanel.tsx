import { useState } from "react";
import { connectedAccountStatusLabel, providerDisplay } from "@packproof/copy/status";
import type {
  ConnectedAccountProviderCatalogView,
  ConnectedAccountView,
} from "../api/types";

export function ConnectedAccountsPanel(props: {
  accounts: ConnectedAccountView[];
  providers: ConnectedAccountProviderCatalogView[];
  notice: string | null;
  busy: boolean;
  onConnect: (provider: string, extra?: { shop?: string }) => void;
  onReauthorize: (accountId: string) => void;
  onDisconnect: (accountId: string) => void;
}) {
  const [shop, setShop] = useState("");

  return (
    <section className="section stack">
      <h2>Connected Accounts</h2>
      <p className="note">
        Link official provider accounts to this PackProof user. This is not PackProof sign-in.
        Tokens stay on the server.
      </p>
      {props.notice ? <div className="banner banner-info">{props.notice}</div> : null}
      {props.accounts.length === 0 ? (
        <p className="meta">No connected accounts yet.</p>
      ) : (
        props.accounts.map((account) => (
          <article key={account.id} className="stack">
            <div className="card-title">{account.providerDisplay || providerDisplay(account.provider)}</div>
            <p className="meta">{account.externalAccountName || account.externalAccountId}</p>
            <p className="meta">{connectedAccountStatusLabel(account.status)}</p>
            {account.capabilities.transactions ? (
              <p className="note">Order import uses the provider APIs PackProof already supports.</p>
            ) : (
              <p className="note">Identity linking only. This provider does not supply PackProof transactions.</p>
            )}
            <div className="btn-row">
              {account.status === "NEEDS_REAUTH" || account.status === "ERROR" ? (
                <button
                  className="btn"
                  type="button"
                  disabled={props.busy}
                  onClick={() => props.onReauthorize(account.id)}
                >
                  Reconnect
                </button>
              ) : null}
              <button
                className="btn btn-secondary"
                type="button"
                disabled={props.busy}
                onClick={() => props.onDisconnect(account.id)}
              >
                Disconnect
              </button>
            </div>
          </article>
        ))
      )}
      {props.providers.map((provider) => {
        const connected = props.accounts.filter((row) => row.provider === provider.provider);
        const canConnect = provider.enabled && (provider.multipleAccounts || connected.length === 0);
        if (!canConnect) {
          return provider.enabled ? null : (
            <p key={provider.provider} className="meta">
              {provider.providerDisplay} is not enabled in this environment.
            </p>
          );
        }
        return (
          <div key={provider.provider} className="stack">
            {provider.requiresShop ? (
              <label className="field" htmlFor={`connected-shop-${provider.provider}`}>
                <span>Shopify shop</span>
                <input
                  id={`connected-shop-${provider.provider}`}
                  value={shop}
                  onChange={(event) => setShop(event.target.value)}
                  placeholder="your-store.myshopify.com"
                  autoComplete="off"
                />
              </label>
            ) : null}
            <button
              className="btn btn-secondary"
              type="button"
              disabled={props.busy || (provider.requiresShop && !shop.trim())}
              onClick={() =>
                props.onConnect(
                  provider.provider,
                  provider.requiresShop ? { shop: shop.trim() } : undefined,
                )
              }
            >
              Connect {provider.providerDisplay}
            </button>
          </div>
        );
      })}
    </section>
  );
}
