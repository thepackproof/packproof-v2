# Intake source support

Observed 2026-09-15. PackProof's ability to receive a supplied text/URL is separate from a marketplace app exposing a useful Share action. No native eBay, Shopify or Etsy order-detail/fulfillment-queue share payload was inspected on a physical Android or iOS device during this implementation. Do not advertise those source-app journeys as verified.

| Provider | OS/source app version | Screen | Actual shared payload | Resolution path | Fallback/status |
| --- | --- | --- | --- | --- | --- |
| eBay | Android, version unverified | Private order detail / fulfillment queue | Unverified; presence of Share unverified | Linked seller API may independently resolve an eligible authorized order | Linked-account queue sync; explicit paste; scan against imported queue. Do not ask users to find an unverified Share action. |
| eBay | iOS, version unverified | Private order detail / fulfillment queue | Unverified; presence of Share unverified | Same seller-authorized backend path | Same queue/paste fallback; iOS signed extension/device acceptance pending. |
| Shopify | Android, version unverified | Order detail / fulfillment queue | Unverified; presence of Share unverified | Authorized store API only, subject to actual granted scopes and connector availability | Linked-store sync where verified; explicit order entry otherwise. |
| Shopify | iOS, version unverified | Order detail / fulfillment queue | Unverified; presence of Share unverified | Same store-authorized backend path | Same queue/paste fallback; iOS signed extension/device acceptance pending. |
| Etsy | Android, version unverified | Order detail / fulfillment queue | Unverified; presence of Share unverified | Generic participant-supplied text/link hints; official connector availability must be independently verified | Explicit review/entry; do not infer that a Share target establishes an official Etsy integration. |
| Etsy | iOS, version unverified | Order detail / fulfillment queue | Unverified; presence of Share unverified | Same untrusted hint boundary | Explicit review/entry; iOS signed extension/device acceptance pending. |
| Mobile browser | Android, browser/version unverified | Seller-selected page | Synthetic text/URL receiver checks only; real seller page not observed | Classify bounded hint; retrieve private order through an authorized connection only | Explicit paste or linked-account queue. A public listing requires selection of an authorized order. |
| Safari | iOS, version unverified | Seller-selected page | Native supported-type contract implemented; actual source payload not observed | Lightweight text/URL Share Extension; no webpage DOM scraping in core | Save locally, open PackProof, resolve/review. No promise of automatic parent-app launch. |
| PackProof owned link | Android/iOS | Packing queue or authorized Proof route | Opaque IDs only; no raw order payload or bearer credential in link | Authenticated API reauthorizes ownership and current allowed action | Safe web fallback; installed distribution link verification still required. |

## Verified source and distribution evidence

Android Play internal version `49` at source `8e3f2959a4c6288d357e716de28d230c92ac9cd8` is the baseline tester build. The newer source includes an iOS host and Share Extension successfully compiled by Xcode in GitHub run `34841421436`, plus an Expo simulator build. These establish baseline package/source and compile evidence only. Neither proves that another company's app offers order sharing, nor that the extension has passed physical-device acceptance.

## Recording a real supported combination

For each combination actually advertised, replace its unverified row with the observed app name/version, OS version, screen, whether Share exists, redacted MIME/UTType and payload shape, whether the identifier is an order or public listing, exact authorized resolution/fallback outcome, and candidate build/date. Retain a sanitized fixture or receipt reference without buyer names, addresses, session tokens or raw private URLs. One synthetic sender test per receiving OS verifies the receiver; it cannot substitute for this source-app observation.

Unknown sources remain participant-supplied hints. A provider label or order-looking number never grants marketplace provenance or permission. A marketplace username never identifies a PackProof participant. No camera starts, evidence is committed, buyer invited or attestation submitted merely because sharing, synchronization, notification or link resolution occurred.
