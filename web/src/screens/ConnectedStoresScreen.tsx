import type { CommerceConnectionView, CommerceSyncView } from "../api/types";

export function ConnectedStoresScreen(props: {
  connections: CommerceConnectionView[];
  lastSync: CommerceSyncView | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  development: boolean;
  onConnectDemo: () => void;
  onSync: (connectionId: string) => void;
}) {
  return (
    <main className="page stack">
      <div className="section-head">
        <div>
          <h1>Connected Stores</h1>
          <p className="lede">
            Commerce connections that can automatically create PackProofs for fulfillment-eligible
            orders. Shopify and other live storefronts are not connected yet.
          </p>
        </div>
      </div>
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
            <p className="note">Live storefront connections will appear here after the Shopify slice.</p>
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
