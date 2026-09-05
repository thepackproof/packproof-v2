import type { ReactNode } from "react";
import { formatDateTime } from "@packproof/copy/format";
import type { CommerceConnectionView, CommerceSyncView, EbayMarketplaceView } from "../api/types";
import { PageHeader } from "../components/PageHeader";

export function ConnectedStoresScreen(props: {
  connectionPanel?: ReactNode;
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
  onAutomation: (connectionId:string,enabled:boolean)=>void;
  onSync: (connectionId: string) => void;
  onBack?: () => void;
}) {
  const ebayConnection = props.ebay?.connection;
  const ebayNeedsReauth = ebayConnection?.status === "NEEDS_REAUTH";

  return (
    <main className="page stack">
      <PageHeader title="Connections" onBack={props.onBack} />
      <p className="lede">
        Connect your store once. Choose which eligible orders become ready to record.
      </p>
      {props.connectionPanel}
      {!props.connectionPanel && props.ebay?.enabled ? (
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
          Order check finished: {props.lastSync.discoveredCount} orders discovered,{" "}
          {props.lastSync.eligibleCount} ready to pack, {props.lastSync.createdProofCount} new
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
            <p className="note">Choose an available selling platform above. Only paid physical orders that still need fulfillment are eligible.</p>
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
              <label className="row"><input type="checkbox" checked={connection.autoSyncEnabled===true} disabled={props.busy||connection.status!=="ACTIVE"} onChange={e=>props.onAutomation(connection.connectionId,e.target.checked)}/> Automatically prepare eligible paid orders for recording</label>
              <p className="note">Paid physical orders with remaining fulfillment enter Orders automatically while this is enabled, even when this tab is closed. Digital, unpaid, cancelled and fully fulfilled orders are excluded. Recording always remains a deliberate action.</p>
              <p className="meta">{connection.autoSyncEnabled ? connection.sync?.initialSyncCompletedAt ? "Automatic intake enabled" : "Initial order check pending or in progress" : "Automatic intake off"}{connection.sync?.runStatus ? ` · ${connection.sync.runStatus.toLowerCase().replaceAll("_"," ")}` : ""}</p>
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
                Check for orders now
              </button>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
