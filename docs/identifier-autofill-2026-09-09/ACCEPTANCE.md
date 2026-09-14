# Multi-identifier candidate acceptance

This is the implementation record for the September 9 development plan. The candidate extends the deployed capture/claims baseline recorded in `BASELINE.md`. Android is version 0.3.13, version code 42. API, web, and Android artifacts must record the same candidate commit at release. Runtime recognition remains off for Gate A.

## Capability matrix

| Surface | Decoder and core formats | Provenance | Qualification |
| --- | --- | --- | --- |
| Android ordinary CameraX recorder | Existing bundled ML Kit 17.2.0; UPC-A/E, EAN-8/13, Code 128/39, QR, Data Matrix, ITF, Code 93, Codabar, PDF417, Aztec | Native format, raw bytes when available, bounds/frame size, monotonic capture offset | Source adapter and recovery tests; signed native build required. Galaxy S24 Ultra and A16 pilot pending. |
| Android encoded-frame inspection | Existing ML Kit inspection after the same recording | Encoded frame source is distinct; sampled extraction offsets remain explicitly approximate | Does not claim exact presentation timestamps or complete video analysis. |
| Browser existing recorder stream | Native BarcodeDetector only when its complete core format set is available; otherwise pinned local ZXing WASM 3.1.3 in a worker | Decoder version, raw-byte/GS1 capability, analysis bounds, approximate monotonic media offset | Actual bundled fallback fixture decoding and native-disabled worker test pass. Physical Chrome/Edge and Safari/Firefox qualification pending. |
| GS1 DataBar, MaxiCode, postal/proprietary/composite variants | No new adapter | Unsupported capability is retained honestly | Extension backlog; not a core release blocker. |

Web analysis uses a resized bitmap from the existing video element, one request at a time, at most roughly three analysis frames per second. Hidden pages pause analysis. Slow/erroring analysis backs off or disables enrichment without acquiring a camera track, pausing the encoder, or fetching scanned content. The WASM binary is a bundled same-site asset. Core GS1 syntax is pinned with its source revision and license in `backend/src/identifiers/gs1`.

## Finite acceptance pack

| Plan gate | Implemented verification | Remaining release evidence |
| --- | --- | --- |
| T01 | Parameterized UPC/EAN/UPC-E/check-digit/leading-zero parser fixtures | Physical print/packaging samples |
| T02 | Mixed product/shipping routing and shipping-only forwarding tests | Mixed-label camera demonstration |
| T03 | Exact SKU case/punctuation, duplicate aliases, numeric ambiguity, store isolation | Authorized real store pilot |
| T04 | Pinned GS1 element strings/Digital Link, serial/lot/SSCC, separator and malformed cases | Real GS1 packaging samples |
| T05 | Read-only eligible-order candidates; product never binds a Proof | Two real eligible orders with one product |
| T06 | Exact authorized source projection with source reference/revision; no buyer/price/quantity inference | Verify connected catalog provenance |
| T07 | Missing, stale, disconnected, unsupported and ambiguous source states | Provider permission/status scenarios |
| T08 | Append-only conflict decisions, unchanged bound context, review barrier | Continuous recording during a real mismatch |
| T09 | Repeated sightings deduplicated; distinct serials/source provenance retained; no quantity claims | Bundle/split-shipment pilot |
| T10 | Durable scoped replay, same-ID lost response, single-flight initialization, saved-media recovery | Force-stop/restart on both devices |
| T11 | Tenant/account isolation, sanitized QR secrets, escaped rendering, size limits; fallback test forbids network lookup | Live browser/device hostile-payload samples |
| T12 | Stale decisions, immutable checkpoint, supplemental arrivals, finalization and restore contracts | PostgreSQL release invariants and signed artifact record |
| T13 | Real local WASM round trips for UPC/EAN/Code128/QR/DataMatrix; BarcodeDetector-absent worker; native adapter format tests | Exact OS/browser/device versions and measured recognition |
| T14 | Bounded queues, finite retry/backoff, optional-service outage and Stop race tests | Three consecutive five-minute recordings per Android phone; thermal/memory/frame-gap comparison and low light/glare/motion |
| T15 | Same canonical projection in participant/shared views; explicit item-identifier grant scope; evidence-ID-limited jumps | Authorized Zendesk launch with reviewed real evidence |
| T16 | Flags default off, session policy pinned, unsupported backend halts optional mutation, old capture/recovery tests | Gate A live health/capabilities and pilot rollback exercise |

Fixture data is confined to test harnesses. No synthetic orders or demo products were written to operational stores. The 10,000-row source-index benchmark is an isolated PGlite lookup measurement, not a measured production resolution or camera latency. Recognition p95 <=1.5 s, server p95 <=500 ms, <=5% frame-rate degradation, and no extra >250 ms gaps remain physical pilot measurements.

## Rollout and rollback

Gate A deploys migration 060 and compatible API/web/mobile candidates with `IDENTIFIER_CAPTURE_ENABLED=false`, `IDENTIFIER_AUTOFILL_ENABLED=false`, and `IDENTIFIER_REVIEW_ENABLED=false`. Gate B requires the exact internal tenant/store and qualified surface allowlists, with observation-only capture. Gate C adds source-backed autofill/review for authorized real products and orders. Gate D remains blocked until all required physical tests pass and artifact identities match.

The kill switch is the capture flag: turn it off for new sessions. Keep the additive schema and compatible server deployed so pinned saved recordings, known conflicts, accepted checkpoints and historical evidence continue to recover. Do not down-migrate evidence or restore an old server that refuses the newer migration inventory. No new paid lookup, carrier tracker from a product code, per-frame connector refresh, second recorder, mandatory scan, or extra attestation step is introduced.

The existing CI gates remain intact; mobile identifier tests are added to the mobile job. The combined local run identified a prior tracking UI test using a removed CSS selector; only the selector was repaired, keeping its assertion that the newest carrier status remains visible while selecting history. The Android release identity test now expects the new version 0.3.13 / 42.
