(() => {
  const adapter = globalThis.PACKPROOF_BROWSER_ADAPTER;
  if (!adapter?.validated || !adapter.selectors?.printLabel || location.origin !== adapter.origin || !new RegExp(adapter.pathPattern).test(location.pathname)) return;
  if (globalThis.packProofPrintObserverInstalled) return;
  globalThis.packProofPrintObserverInstalled = true;
  // Passive observation: never cancel/default-prevent, call print, buy labels or modify fulfillment.
  document.addEventListener('click', event => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const action = event.target.closest(adapter.selectors.printLabel);
    if (!action || action.getClientRects().length === 0 || action.matches(':disabled,[aria-disabled="true"]')) return;
    chrome.runtime.sendMessage({ type: 'PRINT_LABEL' }).catch(() => {});
  }, { capture: true, passive: true });
})();
