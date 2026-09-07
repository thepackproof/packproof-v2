import { useState } from "react";
import { connectedAccountStatusLabel, providerDisplay } from "@packproof/copy/status";
import { ETSY_ATTRIBUTION, providerSetupMessage } from "@packproof/copy/commerce";
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
      <h2>Your platforms</h2>
      <p className="note">
        Authorize a supported store to read order and fulfillment details. This connects your selling account, separate from PackProof sign-in. You choose whether to turn on automatic intake below.
      </p>
      {props.notice ? <div className="banner banner-info">{props.notice}</div> : null}
      {props.accounts.length === 0 ? (
        <p className="meta">Choose a supported platform to get started.</p>
      ) : (
        props.accounts.map((account) => (
          <article key={account.id} className="stack">
            <div className="card-title">{account.providerDisplay || providerDisplay(account.provider)}</div>
            <p className="meta">{account.externalAccountName || account.externalAccountId}</p>
            <p className="meta">{connectedAccountStatusLabel(account.status)}</p>
            {account.capabilities.transactions ? (
              <p className="note">{account.provider === "etsy" ? "Read-only access to your Etsy shop orders. Choose automatic intake below to prepare eligible orders for recording." : "Order import uses the provider APIs PackProof already supports."}</p>
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
              {providerSetupMessage(provider.provider)}
            </p>
          );
        }
        return (
          <div key={provider.provider} className="stack">
            {provider.provider === "etsy" ? <p className="note">Authorize your Etsy shop to read paid orders awaiting shipment. After connecting, turn on automatic intake below to prepare Proofs for recording.</p> : null}
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
      {props.providers.some(provider => provider.provider === "etsy") || props.accounts.some(account => account.provider === "etsy") ? <p className="meta">{ETSY_ATTRIBUTION}</p> : null}
    </section>
  );
}
