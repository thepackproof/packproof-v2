import { formatDateTime } from "@packproof/copy/format";
import type { CommerceConnectionView, CommerceSyncView, EbayMarketplaceView } from "../api/types";

export function ConnectedStoresScreen(props: {
  connections: CommerceConnectionView[];
  lastSync: CommerceSyncView | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  development: boolean;
  ebay: EbayMarketplaceView | null;
  onConnectDemo: () => void;
  onConnectEbay: () => void;
  onDisconnectEbay: () => void;
  onImportSales: () => void;
  onSync: (connectionId: string) => void;
}) {
  const ebayConnection = props.ebay?.connection;
  const ebayNeedsReauth = ebayConnection?.status === "NEEDS_REAUTH";

  return (
    <main className="page stack">
      <div className="section-head">
        <div>
          <h1>Connected Stores</h1>
          <p className="lede">
            Commerce connections that can create PackProofs for fulfillment-eligible orders.
          </p>
        </div>
      </div>
      {props.ebay?.enabled ? (
        <section className="section stack">
          <h2>eBay</h2>
          {ebayConnection ? (
            <>
              <p className="meta">
                Connected as {ebayConnection.displayName || "eBay account"}
                {ebayNeedsReauth ? " · Reconnect required" : ""}
              </p>
              <p className="meta">Last synchronized {formatDateTime(ebayConnection.updatedAt)}</p>
              <p className="note">
                Transaction information is supplied by eBay. PackProof records it but does not
                independently verify listing contents.
              </p>
              <div className="btn-row">
                <button className="btn" type="button" disabled={props.busy} onClick={props.onConnectEbay}>
                  Reconnect
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  disabled={props.busy}
                  onClick={props.onDisconnectEbay}
                >
                  Disconnect
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  disabled={props.busy || ebayNeedsReauth}
                  onClick={props.onImportSales}
                >
                  Import sales
                </button>
              </div>
              <p className="note">Buyer purchase import is not available yet.</p>
            </>
          ) : (
            <button className="btn" type="button" disabled={props.busy} onClick={props.onConnectEbay}>
              Connect eBay
            </button>
          )}
        </section>
      ) : null}
      {props.error ? (
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      ) : null}
      {props.lastSync ? (
        <div className="banner banner-info">
          Sync finished: {props.lastSync.discoveredCount} orders discovered,{" "}
          {props.lastSync.eligibleCount} fulfillment eligible, {props.lastSync.createdProofCount} new
          PackProofs.
        </div>
      ) : null}
      {props.loading ? (
        <p className="empty">Loading stores…</p>
      ) : props.connections.length === 0 ? (
        <section className="section">
          <p className="empty">No commerce connections yet.</p>
          {props.development ? (
            <button className="btn" type="button" disabled={props.busy} onClick={props.onConnectDemo}>
              Connect Demo Storefront
            </button>
          ) : (
            <p className="note">Connect Shopify from Connected Accounts. Synced shops appear here.</p>
          )}
        </section>
      ) : (
        <div className="card-list">
          {props.connections.map((connection) => (
            <article key={connection.connectionId} className="section">
              <h2>{connection.externalAccountReference === "demo-store-001" ? "Demo Store" : connection.providerDisplay}</h2>
              <p className="meta">
                {connection.providerDisplay} · {connection.status}
              </p>
              <p className="meta">{connection.readyOrderCount} orders ready</p>
              {connection.lastSyncAt ? <p className="meta">Last sync {connection.lastSyncAt}</p> : null}
              {connection.lastErrorCode ? (
                <p className="note">Last sync error: {connection.lastErrorCode}</p>
              ) : null}
              <button
                className="btn"
                type="button"
                disabled={props.busy}
                onClick={() => props.onSync(connection.connectionId)}
              >
                Sync now
              </button>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
