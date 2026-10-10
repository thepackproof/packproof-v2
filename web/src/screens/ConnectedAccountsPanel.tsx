import { useState } from "react";
import { useMobileTaskExperience } from "../mobile-task/useMobileTaskExperience";
import { formatDateTime } from "@packproof/copy/format";
import { connectedAccountStatusLabel, providerDisplay } from "@packproof/copy/status";
import { ETSY_ATTRIBUTION, SHOPIFY_AUTOMATIC_PROOFS_LABEL, orderIntakeExplanation, orderReviewReason } from "@packproof/copy/commerce";
import type { CommerceConnectionView, ConnectedAccountProviderCatalogView, ConnectedAccountView } from "../api/types";
import "./account-settings.css";
import "./workstation-tools.css";

export interface ConnectedAccountsPanelProps {
  accounts: ConnectedAccountView[];
  providers: ConnectedAccountProviderCatalogView[];
  notice: string | null;
  busy: boolean;
  connections?: CommerceConnectionView[];
  onAutomation?: (connectionId: string, enabled: boolean) => void;
  onSync?: (connectionId: string) => void;
  onConnect: (provider: string, extra?: { shop?: string; autoSyncEnabled?: boolean }) => void;
  onReauthorize: (accountId: string) => void;
  onDisconnect: (accountId: string) => void;
}

function intakeStatus(connection: CommerceConnectionView): string {
  if (connection.status === "NEEDS_REAUTH") return "Automatic orders are paused. Reconnect your selling account.";
  if (connection.status !== "ACTIVE") return "Automatic orders are unavailable while this connection needs attention.";
  if (connection.automationAvailable === false) return "Automatic orders are not available for this store yet.";
  if (!connection.autoSyncEnabled) return "Automatic orders are off.";
  if (connection.sync?.runStatus === "FAILED") return "The latest order check failed. Try checking again.";
  if (connection.sync?.runStatus === "RETRYING") return "The last order check was delayed. PackProof will retry.";
  return connection.sync?.initialSyncCompletedAt ? "Automatic orders are on." : "Initial order check pending or in progress";
}

export function ConnectedAccountsPanel(props: ConnectedAccountsPanelProps) {
  const [shops, setShops] = useState<Record<string, string>>({});
  const [connectionSetup, setConnectionSetup] = useState<Record<string, boolean>>({});
  const [shopifyAutomaticProofs, setShopifyAutomaticProofs] = useState(true);
  const providers = [...new Set([
    ...props.providers.map(provider => provider.provider),
    ...props.accounts.map(account => account.provider),
    ...(props.connections ?? []).map(connection => connection.provider),
  ])];

  const mobileTask = useMobileTaskExperience();
  const isUnavailable = (provider: string) => {
    const catalog = props.providers.find(row => row.provider === provider);
    return !(catalog?.enabled && catalog.capabilities.transactions) && !props.accounts.some(row => row.provider === provider) && !(props.connections ?? []).some(row => row.provider === provider);
  };
  const currentProviders = mobileTask ? providers.filter(provider => !isUnavailable(provider)) : providers;
  const unavailableProviders = mobileTask ? providers.filter(isUnavailable) : [];
  const renderProvider = (provider: string) => {
      const catalog = props.providers.find(row => row.provider === provider);
      const accounts = props.accounts.filter(row => row.provider === provider);
      const connections = (props.connections ?? []).filter(row => row.provider === provider);
      const available = catalog?.enabled !== false;
      const currentAccounts = accounts.filter(row => row.status !== "DISCONNECTED");
      const label = catalog?.providerDisplay || accounts[0]?.providerDisplay || connections[0]?.providerDisplay || providerDisplay(provider);
      const canConnect = catalog?.enabled && catalog.capabilities.transactions && (catalog.multipleAccounts || currentAccounts.length === 0) && (connections.length === 0 || accounts.length > 0);
      const shop = shops[provider] ?? "";
      const connected = currentAccounts.some(account => ["CONNECTED", "ACTIVE"].includes(account.status)) || (accounts.length === 0 && connections.some(connection => connection.status === "ACTIVE"));
      const needsAttention = currentAccounts.some(account => ["NEEDS_REAUTH", "ERROR"].includes(account.status)) || connections.some(connection => connection.status === "NEEDS_REAUTH");
      const status = !available ? "Unavailable" : needsAttention ? "Needs attention" : connected ? "Connected" : "Not connected";
      return <article className="section stack sales-channel ws-integration-card" key={provider} aria-label={label}>
        <div className="ws-provider-heading"><span className={`ws-provider-mark ws-provider-${provider}`} aria-hidden="true">{provider === "ebay" ? "e" : label.charAt(0)}</span><span className={`ws-provider-status${connected && available && !needsAttention ? " is-connected" : needsAttention ? " needs-attention" : ""}`}>{status}</span></div>
        <h2>{label}</h2>
        <p className="ws-provider-description">{catalog?.capabilities.transactions || connections.length ? "Bring synchronized orders into your packing queue." : "Link account records with your PackProof workspace."}</p>
        {!available && (accounts.length > 0 || connections.length > 0) && <p className="banner banner-info">{label} is temporarily unavailable. Your existing connection remains listed here.</p>}
        {accounts.map(account => <div className="stack channel-account" key={account.id}>
          <p className="card-title">{account.externalAccountName || "Selling account"}</p>
          <p className="meta">{connectedAccountStatusLabel(account.status)}</p>
          {!account.capabilities.transactions && <p className="note">This account connection does not supply orders to PackProof.</p>}
          <div className="btn-row">
            {available && (["NEEDS_REAUTH", "ERROR"].includes(account.status) || connections.some(connection => connection.connectionId === account.id && connection.status === "NEEDS_REAUTH")) && <button className="btn btn-secondary" type="button" disabled={props.busy} onClick={() => props.onReauthorize(account.id)}>Reconnect</button>}
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
            <label className="channel-toggle"><input type="checkbox" checked={connection.autoSyncEnabled === true} disabled={props.busy || !props.onAutomation || ((!canRead || connection.automationAvailable === false) && !connection.autoSyncEnabled)} onChange={event => props.onAutomation?.(connection.connectionId, event.target.checked)} /> <span>{provider === "shopify" ? SHOPIFY_AUTOMATIC_PROOFS_LABEL : "Automatically add orders"}</span></label>
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
        {catalog && <details className="settings-detail ws-provider-details"><summary>Connection details</summary><div className="stack"><p className="note">{!available ? `${label} is temporarily unavailable for new connections.` : catalog.capabilities.transactions ? "Eligible orders from this selling account can be added to your packing queue. You choose whether to add them automatically." : "This provider supports account records only. It does not supply orders to PackProof; connecting it as a sales channel is unavailable."}</p>{catalog.limitations.map((limitation, index) => <p key={`${index}-${limitation}`} className="note">{limitation}</p>)}</div></details>}
        {!canConnect && currentAccounts.length === 0 && connections.length === 0 && <button className="btn ws-provider-unavailable" type="button" disabled aria-describedby={`provider-unavailable-${provider}`}>Connect {label}<span aria-hidden="true"> →</span></button>}
        {!canConnect && currentAccounts.length === 0 && connections.length === 0 && <span id={`provider-unavailable-${provider}`} className="visually-hidden">{!available ? "New connections are unavailable." : "This provider does not supply orders to PackProof."}</span>}
        {canConnect && <div className="stack ws-provider-connect">
          {catalog.requiresShop && !connectionSetup[provider] ? <button id={`configure-provider-${provider}`} className="btn" type="button" disabled={props.busy} onClick={() => setConnectionSetup(previous => ({ ...previous, [provider]: true }))}>Connect {label}<span aria-hidden="true"> →</span></button> : <>
          {catalog.requiresShop && <label className="field" htmlFor={`connected-shop-${provider}`}><span>Shopify shop</span><input id={`connected-shop-${provider}`} value={shop} disabled={props.busy} onChange={event => setShops(previous => ({...previous, [provider]: event.target.value}))} placeholder="your-store.myshopify.com" autoComplete="off" autoFocus /></label>}
          {provider === "shopify" && <>
            <label className="channel-toggle"><input type="checkbox" checked={shopifyAutomaticProofs} disabled={props.busy} aria-describedby="shopify-automatic-proofs-explanation" onChange={event => setShopifyAutomaticProofs(event.target.checked)} /> <span>{SHOPIFY_AUTOMATIC_PROOFS_LABEL}</span></label>
            <p className="note" id="shopify-automatic-proofs-explanation">{orderIntakeExplanation(provider)}</p>
          </>}
          <div className="btn-row"><button className="btn" type="button" disabled={props.busy || (catalog.requiresShop && !shop.trim())} onClick={() => props.onConnect(provider, provider === "shopify" ? { shop: shop.trim(), autoSyncEnabled: shopifyAutomaticProofs } : catalog.requiresShop ? { shop: shop.trim() } : undefined)}>{catalog.requiresShop ? "Continue to" : "Connect"} {label}<span aria-hidden="true"> →</span></button>{catalog.requiresShop && <button type="button" className="btn btn-tertiary" disabled={props.busy} onClick={() => { setConnectionSetup(previous => ({ ...previous, [provider]: false })); requestAnimationFrame(() => document.getElementById(`configure-provider-${provider}`)?.focus()); }}>Cancel</button>}</div>
          </>}
        </div>}
      </article>;
  };  return <section className="stack ws-integrations" aria-label="Sales channels">
    <div className="ws-integration-notice"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg><p>Your marketplace sign-in is separate from PackProof sign-in. Connect a selling account, then choose whether to add its eligible orders automatically.</p></div>
    {props.notice && <div className="banner banner-info" role="status">{props.notice}</div>}
    {providers.length === 0 && <p className="note">No sales channels are available to connect right now. You can still record a shipment from Orders.</p>}
    <div className="ws-integration-grid">{currentProviders.map(renderProvider)}</div>
    {unavailableProviders.length > 0 && <details className="settings-detail"><summary>Coming soon / unavailable channels ({unavailableProviders.length})</summary><p className="note">These channels cannot currently supply orders in this environment. Availability follows the service catalog; no release date is promised.</p><div className="ws-integration-grid">{unavailableProviders.map(renderProvider)}</div></details>}
    {providers.includes("etsy") && <p className="meta">{ETSY_ATTRIBUTION}</p>}
  </section>;
}
