import { salesChannelCanConnect, type SalesChannel } from '../copy/sales-channels';

/** Presentation only. Connection and automation operations keep their existing owners. */
export function integrationPresentation(channel: SalesChannel) {
  const attention = channel.accounts.some(({ account, connection }) =>
    account?.status === 'NEEDS_REAUTH' || account?.status === 'ERROR' || connection?.status === 'NEEDS_REAUTH' || connection?.status === 'ERROR');
  const connected = channel.accounts.some(({ account, connection }) =>
    account ? ['CONNECTED', 'ACTIVE'].includes(account.status) : connection?.status === 'ACTIVE');
  const canConnect = salesChannelCanConnect(channel) && Boolean(channel.catalog?.capabilities.transactions || channel.catalog?.capabilities.fulfillment);
  return {
    canConnect,
    status: attention ? 'Needs attention' : connected ? 'Connected' : canConnect ? 'Not connected' : 'Unavailable',
    action: channel.accounts.length ? 'Open' : canConnect ? 'Connect' : null,
  };
}
