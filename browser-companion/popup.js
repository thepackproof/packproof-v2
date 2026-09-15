const text = document.querySelector('#status'), record = document.querySelector('#record'), automatic = document.querySelector('#automatic');
const reasons = { PAGE_ADAPTER_NOT_VALIDATED: 'This eBay page adapter is awaiting validation. Open PackProof and choose an imported order.', CONNECT_PACKPROOF: 'Connect your PackProof account first.', STORE_ACCOUNT_MISMATCH: 'This eBay account differs from the store you connected.', ITEM_CONTEXT_MISSING: 'This page does not show all purchased items and quantities.', ORDER_IDENTITY_MISSING: 'The exact order identity is missing.', ORDER_NOT_READY: 'This order is not ready for packing.', FULFILLMENT_SCOPE_UNRESOLVED: 'Open this order in PackProof to review its shipment scope.', UNSUPPORTED_PAGE: 'Open a supported single-order page, or choose the order in PackProof.', PENDING_QUEUE_FULL: 'Open PackProof to send your waiting orders.', SELECT_ONE_ORDER: 'Open one order before recording.', TRY_AGAIN: 'The order could not be sent. Your saved requests will be retried when PackProof is open.' };
const show = result => { text.textContent = result.ok ? 'Order ready; open PackProof on your recording phone.' : reasons[result.reason] || 'Open PackProof to continue with this order.'; };
chrome.runtime.sendMessage({ type: 'STATUS' }).then(status => { automatic.checked = status.automatic; record.disabled = !status.validated; automatic.disabled = !status.validated; text.textContent = status.validated ? status.connected ? `${status.pending} order requests waiting.` : 'Connect PackProof once to select your store and recording phone.' : reasons.PAGE_ADAPTER_NOT_VALIDATED; });
record.addEventListener('click', () => { record.disabled = true; chrome.runtime.sendMessage({ type: 'RECORD' }).then(show).finally(() => { record.disabled = false; }); });
document.querySelector('#connect').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CONNECT' }));
automatic.addEventListener('change', async () => {
  if (automatic.checked && !await chrome.permissions.request({ origins: ['https://www.ebay.com/*'] })) { automatic.checked = false; return; }
  const result = await chrome.runtime.sendMessage({ type: 'AUTOMATIC', enabled: automatic.checked });
  if (!result.ok) { automatic.checked = false; show(result); }
  if (!automatic.checked) await chrome.permissions.remove({ origins: ['https://www.ebay.com/*'] });
});
