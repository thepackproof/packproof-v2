/* Versioned, bounded visible-DOM reader. No page scripts, cookies or hidden API data. */
(() => {
  function extractPage(descriptor) {
    const fail = reason => ({ ok: false, reason });
    if (!descriptor?.validated || !descriptor.fixtureDigest) return fail('PAGE_ADAPTER_NOT_VALIDATED');
    if (location.origin !== descriptor.origin || !new RegExp(descriptor.pathPattern).test(location.pathname) || document.documentElement.lang !== descriptor.locale) return fail('UNSUPPORTED_PAGE');
    const selectors = descriptor.selectors;
    const roots = document.querySelectorAll(selectors.root);
    if (roots.length !== 1) return fail('SELECT_ONE_ORDER');
    const root = roots[0];
    const visible = element => !!element && !element.hidden && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length > 0;
    const text = (parent, selector, max = 1000) => {
      const matches = parent.querySelectorAll(selector);
      if (matches.length !== 1 || !visible(matches[0])) return null;
      const value = matches[0].textContent.trim();
      return value && value.length <= max ? value : null;
    };
    if (!visible(root)) return fail('UNSUPPORTED_PAGE');
    const externalOrderId = text(root, selectors.orderId, 128), accountReference = text(document, selectors.accountReference, 200);
    if (!externalOrderId || !/^[a-zA-Z0-9_-]+$/.test(externalOrderId) || !accountReference) return fail('ORDER_IDENTITY_MISSING');
    const rows = root.querySelectorAll(selectors.item);
    if (!rows.length || rows.length > 100) return fail('ITEM_CONTEXT_MISSING');
    const items = [];
    for (const row of rows) {
      if (!visible(row)) return fail('ITEM_CONTEXT_MISSING');
      const title = text(row, selectors.title), quantityText = text(row, selectors.quantity, 10);
      if (!title || !quantityText || !/^[1-9]\d{0,5}$/.test(quantityText)) return fail('ITEM_CONTEXT_MISSING');
      const variant = selectors.variant ? text(row, selectors.variant) : null;
      if (selectors.variantRequired && !variant) return fail('VARIANT_CONTEXT_MISSING');
      items.push({ title, quantity: Number(quantityText), variant, sku: selectors.sku ? text(row, selectors.sku, 200) : null });
    }
    const status = text(root, selectors.status, 64);
    if (!descriptor.paidStatuses.includes(status)) return fail('ORDER_NOT_READY');
    // Whole-order/physical eligibility must be an explicitly reviewed page family property.
    if (!descriptor.physicalFullOrder || (selectors.partial && root.querySelector(selectors.partial)) || (selectors.batch && document.querySelector(selectors.batch))) return fail('FULFILLMENT_SCOPE_UNRESOLVED');
    const observation = { sourceKind: 'BROWSER_CAPTURED', externalOrderId, orderReference: selectors.orderReference ? text(root, selectors.orderReference, 200) : externalOrderId, items, physicalFulfillment: true, paid: true, cancelled: false, fulfillmentScope: 'FULL_ORDER' };
    const sourceExcerpt = JSON.stringify({ externalOrderId, accountReference, status, items });
    if (sourceExcerpt.length > 64000) return fail('SOURCE_TOO_LARGE');
    return { ok: true, observation, pageAccountReference: accountReference, sourceExcerpt, sourceUrl: location.origin + location.pathname };
  }
  globalThis.PackProofPageParser = { extractPage };
})();
