import { useState } from "react";
import { formatDateTime } from "@packproof/copy/format";
import { connectedAccountStatusLabel, providerDisplay } from "@packproof/copy/status";
import { ETSY_ATTRIBUTION, orderIntakeExplanation, orderReviewReason } from "@packproof/copy/commerce";
import type { CommerceConnectionView, ConnectedAccountProviderCatalogView, ConnectedAccountView } from "../api/types";
import "./account-settings.css";

export interface ConnectedAccountsPanelProps {
  accounts: ConnectedAccountView[];
  providers: ConnectedAccountProviderCatalogView[];
  notice: string | null;
  busy: boolean;
  connections?: CommerceConnectionView[];
  onAutomation?: (connectionId: string, enabled: boolean) => void;
  onSync?: (connectionId: string) => void;
  onConnect: (provider: string, extra?: { shop?: string }) => void;
  onReauthorize: (accountId: string) => void;
  onDisconnect: (accountId: string) => void;
}

function intakeStatus(connection: CommerceConnectionView): string {
  if (connection.status === "NEEDS_REAUTH") return "Automatic orders are paused. Reconnect your selling account.";
  if (connection.status !== "ACTIVE") return "Automatic orders are unavailable while this connection needs attention.";
  if (!connection.autoSyncEnabled) return "Automatic orders are off.";
  if (connection.sync?.runStatus === "FAILED") return "The latest order check failed. Try checking again.";
  if (connection.sync?.runStatus === "RETRYING") return "The last order check was delayed. PackProof will retry.";
  return connection.sync?.initialSyncCompletedAt ? "Automatic orders are on." : "Initial order check pending or in progress";
}

export function ConnectedAccountsPanel(props: ConnectedAccountsPanelProps) {
  const [shops, setShops] = useState<Record<string, string>>({});
  const providers = [...new Set([
    ...props.providers.filter(provider => provider.enabled && provider.capabilities.transactions).map(provider => provider.provider),
    ...props.accounts.map(account => account.provider),
    ...(props.connections ?? []).map(connection => connection.provider),
  ])];

  return <section className="stack" aria-label="Sales channels">
    <p className="note">Your marketplace sign-in is separate from PackProof sign-in. Connect a selling account, then choose whether to add its eligible orders automatically.</p>
    {props.notice && <div className="banner banner-info" role="status">{props.notice}</div>}
    {providers.length === 0 && <p className="note">No sales channels are available to connect right now. You can still record a shipment from Orders.</p>}
    {providers.map(provider => {
      const catalog = props.providers.find(row => row.provider === provider);
      const accounts = props.accounts.filter(row => row.provider === provider);
      const connections = (props.connections ?? []).filter(row => row.provider === provider);
      const available = catalog?.enabled !== false;
      const currentAccounts = accounts.filter(row => row.status !== "DISCONNECTED");
      const label = catalog?.providerDisplay || accounts[0]?.providerDisplay || connections[0]?.providerDisplay || providerDisplay(provider);
      const canConnect = catalog?.enabled && catalog.capabilities.transactions && (catalog.multipleAccounts || currentAccounts.length === 0) && (connections.length === 0 || accounts.length > 0);
      const shop = shops[provider] ?? "";
      return <article className="section stack sales-channel" key={provider} aria-label={label}>
        <h2>{label}</h2>
        {!available && <p className="banner banner-info">{label} is temporarily unavailable. Your existing connection remains listed here.</p>}
        {accounts.map(account => <div className="stack channel-account" key={account.id}>
          <p className="card-title">{account.externalAccountName || "Selling account"}</p>
          <p className="meta">{connectedAccountStatusLabel(account.status)}</p>
          {!account.capabilities.transactions && <p className="note">This account connection does not supply orders to PackProof.</p>}
          <div className="btn-row">
            {available && ["NEEDS_REAUTH", "ERROR"].includes(account.status) && <button className="btn btn-secondary" type="button" disabled={props.busy} onClick={() => props.onReauthorize(account.id)}>Reconnect</button>}
            {account.status !== "DISCONNECTED" && <button className="btn btn-tertiary" type="button" disabled={props.busy} onClick={() => props.onDisconnect(account.id)}>Disconnect</button>}
          </div>
        </div>)}
        {connections.map(connection => {
          // Do not attach a different store's permission state to this intake connection.
          const matched = accounts.find(account => account.id === connection.connectionId || (connection.externalAccountReference !== null && [account.externalAccountId, account.externalAccountName].includes(connection.externalAccountReference)));
          const identity = matched ?? (accounts.length === 1 && connections.length === 1 ? accounts[0] : undefined);
          const permissionHealthy = !identity || identity.status === "CONNECTED" || identity.status === "ACTIVE";
          const canRead = available && connection.status === "ACTIVE" && permissionHealthy && identity?.capabilities.transactions !== false;
          return <div className="stack channel-orders" key={connection.connectionId}>
            {(connections.length > 1 || accounts.length === 0) && <p className="card-title">{connection.externalAccountReference || "Connected store"}</p>}
            <label className="channel-toggle"><input type="checkbox" checked={connection.autoSyncEnabled === true} disabled={props.busy || !props.onAutomation || (!canRead && !connection.autoSyncEnabled)} onChange={event => props.onAutomation?.(connection.connectionId, event.target.checked)} /> <span>Automatically add orders</span></label>
            <p className="meta">{intakeStatus(connection)}</p>
            {!permissionHealthy && connection.status === "ACTIVE" && <p className="note">Order checks are paused until this selling account is reconnected.</p>}
            {connection.lastErrorCode && <p className="note" role="status">The latest order check could not finish. {connection.status === "NEEDS_REAUTH" ? "Reconnect your selling account to continue." : "Try checking again. Your saved Proofs are still available."}</p>}
            <p className="meta">{connection.readyOrderCount} {connection.readyOrderCount === 1 ? "order" : "orders"} ready to pack</p>
            <p className="meta">{connection.lastSyncAt ? `Last successful order check ${formatDateTime(connection.lastSyncAt)}` : "No successful order check yet"}</p>
            {(connection.reviewOrderCount ?? 0) > 0 && <p className="note">{connection.reviewOrderCount} orders need review and are excluded from automatic Proof creation. {(connection.reviewReasons ?? []).map(reason => `${orderReviewReason(reason.code)}: ${reason.count}`).join(" · ")}. Review the original orders in {label}.</p>}
            <button className="btn btn-secondary" type="button" disabled={props.busy || !canRead || !props.onSync} onClick={() => props.onSync?.(connection.connectionId)}>Check for orders now</button>
            <details className="settings-detail"><summary>Which orders are added?</summary><p className="note">{orderIntakeExplanation(provider)}</p></details>
          </div>;
        })}
        {currentAccounts.some(account => account.capabilities.transactions) && connections.length === 0 && <p className="note">The account is linked, but order access is not ready yet. Refresh this page to check again. Recording a shipment remains available in Orders.</p>}
        {canConnect && <div className="stack">
          {catalog.requiresShop && <label className="field" htmlFor={`connected-shop-${provider}`}><span>Shopify shop</span><input id={`connected-shop-${provider}`} value={shop} onChange={event => setShops(previous => ({...previous, [provider]: event.target.value}))} placeholder="your-store.myshopify.com" autoComplete="off" /></label>}
          <button className="btn btn-secondary" type="button" disabled={props.busy || (catalog.requiresShop && !shop.trim())} onClick={() => props.onConnect(provider, catalog.requiresShop ? { shop: shop.trim() } : undefined)}>Connect {label}</button>
        </div>}
      </article>;
    })}
    {providers.includes("etsy") && <p className="meta">{ETSY_ATTRIBUTION}</p>}
  </section>;
}
