# PackProof Companion internal build 0.1.0

This build contains the permission boundary, durable queue, authenticated-app bridge, and bounded visible-page parser. The eBay page descriptor is **disabled and unvalidated** because no authorized representative seller page was available. The synthetic parser tests are not a production template fixture. Selecting an imported order in PackProof remains available.

## Install for internal review

1. Open Chrome or Edge extension management and enable Developer mode.
2. Choose **Load unpacked**, selecting this `browser-companion` directory.
3. Select **Connect PackProof**. Sign in using the existing PackProof account and choose a verified store and approved recording device in the webapp.
4. Once an actual page fixture is reviewed and a release enables `config.js`, open that exact supported single-order page and select **Record packing**. The existing recording phone receives the order context; Record is its acceptance.
5. The optional print observer requires a separate eBay host permission requested only when its checkbox is selected. Newly loaded supported pages receive the observer. Reload a previously open page after enabling it.

The reviewed adapter must provide exact order-ID and visible seller-account selectors, complete item/quantity/variant selectors, paid-state vocabulary, an explicit single physical order scope, an exact print-label action selector, an authorized fixture digest, and a validated locale/page family. `order_number` is not interchangeable with an external provider ID. A reviewed build must verify the visible account reference against the server-owned connected-store mapping. Do not switch `validated` on using guessed selectors.

## App bridge

Only the PackProof HTTPS origins declared in the manifest may send external messages. Call `chrome.runtime.sendMessage(extensionId, message)`. The extension ID comes from `/app?companion=<id>`. Credentials never enter marketplace content scripts or the extension queue.

- `PACKPROOF_COMPANION_CONFIGURE`: `{ownerId, connectionId, accountReference}` from the authenticated server-verified store mapping.
- `PACKPROOF_COMPANION_PULL`: `{ownerId}` returns up to five owner-bound events. Each includes `eventId`, `connectionId`, `pageAccountReference`, `adapterKey`, `adapterVersion`, `sourceUrl`, `createdAt`, `trigger`, `observation`, and `sourceExcerpt`.
- The app durably submits the excerpt through the authorized intake boundary, then creates the target-device handoff using the resulting immutable snapshot. API admission must verify the selected connection, namespace mapping, actual browser provenance, adapter/version admission, and source completeness; the extension is not authoritative.
- `PACKPROOF_COMPANION_ACK`: `{ownerId,eventId}` only after those server commands durably succeed. The backend uses the same event ID on retries. The extension stores only dedupe identifiers after acknowledgment.
- `PACKPROOF_COMPANION_DISCONNECT`: `{ownerId}` revokes automatic observation and the extension connection. Call on sign-out/account changes.

Pull on the authenticated Ready surface with bounded polling and one in-flight request. Stop while recording, backgrounded, idle, or signed out. An offline/busy phone means **Order ready; open PackProof on your recording phone**. A print event indicates selected-order intent only; it cannot mean successful printing, purchased postage, shipping progression or completed Proof.

## Persistence and permissions

Pending events persist in trusted extension storage across service-worker suspension. Replay uses the stable event ID; same-context clicks/prints are deduplicated for ten minutes. The queue holds at most 30 bounded excerpts, expires undelivered local copies after 24 hours, and uses alarms for bounded cleanup. The server's prepared order has its own retention and survives an expired handoff. Failed submission must stay unacknowledged. No `<all_urls>`, cookie, browsing history, network interception, printer, API-token or page-message bridge permission is requested. DOM text is data; render with `textContent` or React escaping, never `innerHTML`.

The explicit action uses `activeTab` and `scripting`. Ongoing observation has separate optional `https://www.ebay.com/*` host access (Chrome grants at host granularity) and only injects on the selected `/sh/ord/details*` family. The observer is passive and never prevents the original print action. Revoking host access disables it.

## Verification

`node --test browser-companion/tests/parser.test.cjs`

The small synthetic suite covers disabled-adapter gating, multi-item preservation, bounded/incomplete context, multiple-order ambiguity, hidden elements and foreign-origin rejection. Real eBay DOM validation, Chrome/Edge end-to-end execution, foreground-phone latency and hardware capture are outstanding release gates. Public browser-store publication is a separate release operation.

## Shippo read-only adapter

`backend/src/integrations/shippo/orders.ts` exports `readShippoOrderBatch` and `normalizeShippoOrder`. The worker must pass an authorized merchant credential from the existing credential store under **shippo-orders**, with exact `tenantId`, `connectionId`, `merchantAccountId`, `ordersAuthorized:'true'`, and `accessToken` or `apiKey`. The platform's **shippo-tracker** credential never qualifies. The normalized scope must be server-owned and verified.

Supply `retainSource` to save exact response bytes privately before normalization. Ingest each returned observation with the shared intake command, then atomically persist `nextCursor`; never advance a cursor before observations commit. A worker crash safely replays deterministic receipts. Scope the worker lease to the existing connection and reuse its retry/health persistence. `ShippoOrdersError.retryAfterMs` gives a bounded delayed retry; authorization errors require reconnecting and should not loop. Existing worker attempt caps govern repeated transient failures.

Discovery reads at most two 50-item pages per invocation. It also revisits at most ten known open/unrecorded object IDs on every batch, including orders placed before the discovery date. The cursor freezes that known-ID queue across restarts. Supply at most 1,000 known IDs per cycle; a larger deployment must partition the existing worker's reconciliation inventory without dropping IDs. Start another cycle after `nextCursor:null`. Placement date filters are not update cursors.

`resolveIdentity(shippoOrderId)` may return an **already established exact object-ID alias** to a canonical marketplace identity. Never derive it from display order number, buyer, address, price, tracking number, or item similarity. Without an alias, the order retains the merchant-scoped Shippo identity. Raw Shippo status `SHIPPED` represents label creation and does not establish payment, carrier acceptance, or Proof completion. Missing line items/quantities remain missing. Partial and multiple-transaction scope cannot claim a full-order capture automatically.

Shippo merchant authorization and OAuth application credentials were not available for live validation. The provider path is therefore **externally blocked**, regardless of source-level tests. The application requires Shippo-provisioned OAuth client credentials for the chosen merchant-owned account flow; configuring the existing tracking key does not resolve that dependency.

Official references, checked September 8, 2026:

- [Shippo Orders](https://docs.goshippo.com/orders/orders)
- [Shippo integration paths and OAuth dependency](https://docs.goshippo.com/guides/integration-paths)
- [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [Chrome service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
