import type { ConnectedAccountProviderCatalogView, ConnectedAccountView, IntegrationConnectionView } from "../v2-api";

export interface SalesChannelAccount {
  account: ConnectedAccountView | null;
  connection: IntegrationConnectionView | null;
}
export interface SalesChannel {
  provider: string;
  providerDisplay: string;
  catalog: ConnectedAccountProviderCatalogView | null;
  accounts: SalesChannelAccount[];
}

function accountReference(provider: string, reference: string | null | undefined): string {
  const value = reference?.trim() ?? "";
  return provider === "shopify"
    ? value.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/\.myshopify\.com$/, "")
    : value;
}

/** Connection permission and order ingestion remain independent inside one provider card. */
export function salesChannels(
  accounts: ConnectedAccountView[],
  connections: IntegrationConnectionView[],
  catalog: ConnectedAccountProviderCatalogView[],
): SalesChannel[] {
  const providers = new Set([
    ...catalog.filter(provider => provider.enabled && (provider.capabilities.transactions || provider.capabilities.fulfillment)).map(provider => provider.provider),
    ...accounts.map(account => account.provider),
    ...connections.map(connection => connection.provider),
  ]);
  return [...providers].sort().map(provider => {
    const definition = catalog.find(item => item.provider === provider) ?? null;
    const available = connections.filter(connection => connection.provider === provider);
    const claimed = new Set<string>();
    const entries: SalesChannelAccount[] = accounts.filter(account => account.provider === provider).map(account => {
      const connection = available.find(connection => !claimed.has(connection.connectionId) && connection.connectionId === account.id)
        ?? available.find(connection => !claimed.has(connection.connectionId)
          && Boolean(connection.externalAccountReference)
          && accountReference(provider, connection.externalAccountReference) === accountReference(provider, account.externalAccountId))
        ?? null;
      if (connection) claimed.add(connection.connectionId);
      return { account, connection };
    });
    for (const connection of available) if (!claimed.has(connection.connectionId)) entries.push({ account: null, connection });
    return {
      provider,
      providerDisplay: definition?.providerDisplay || accounts.find(account => account.provider === provider)?.providerDisplay || available[0]?.providerDisplay || provider,
      catalog: definition,
      accounts: entries,
    };
  });
}

export function salesChannelCanConnect(channel: SalesChannel): boolean {
  return channel.catalog?.enabled === true && (channel.catalog.multipleAccounts
    || !channel.accounts.some(({ account }) => account && account.status !== "DISCONNECTED"));
}
