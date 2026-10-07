import { cloneElement, isValidElement, type ReactNode } from "react";
import type { CommerceConnectionView, CommerceSyncView, EbayMarketplaceView } from "../api/types";
import { PageHeader } from "../components/PageHeader";
import { Glyph } from "../site/Brand";
import { ConnectedAccountsPanel, type ConnectedAccountsPanelProps } from "./ConnectedAccountsPanel";

export function ConnectedStoresScreen(props: {
  intakeSettings?: ReactNode;
  connectionPanel?: ReactNode;
  connections: CommerceConnectionView[];
  lastSync: CommerceSyncView | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  development: boolean;
  ebay: EbayMarketplaceView | null;
  onConnectEbay: () => void;
  onDisconnectEbay: () => void;
  onImportSales: () => void;
  onAutomation: (connectionId: string, enabled: boolean) => void;
  onSync: (connectionId: string) => void;
  onBack?: () => void;
  onCreate?: () => void;
}) {
  const panel = isValidElement<ConnectedAccountsPanelProps>(props.connectionPanel) && props.connectionPanel.type === ConnectedAccountsPanel
    ? cloneElement(props.connectionPanel, { connections: props.connections, onAutomation: props.onAutomation, onSync: props.onSync })
    : <ConnectedAccountsPanel accounts={[]} providers={[]} notice={null} busy={props.busy} connections={props.connections} onAutomation={props.onAutomation} onSync={props.onSync} onConnect={props.onConnectEbay} onReauthorize={props.onConnectEbay} onDisconnect={props.onDisconnectEbay} />;
  return <main className="page stack ws-integrations-page">
    <div className="ws-integrations-heading"><div className="ws-tools-heading"><p className="ws-tools-eyebrow">Your workspace</p><PageHeader title="Integrations" subtitle="Connect your orders and their source records." /></div>{props.onCreate && <button className="btn" onClick={props.onCreate}><Glyph name="plus" size={16} />New Proof</button>}</div>
    {props.error && <div className="banner banner-error" role="alert">{props.error}</div>}
    {props.lastSync && <p className="banner banner-info" role="status">Order check finished: {props.lastSync.eligibleCount} ready to pack, {props.lastSync.createdProofCount} new Proofs prepared.</p>}
    {props.loading ? <p role="status">Loading Connections…</p> : panel}
    {props.intakeSettings}
  </main>;
}
