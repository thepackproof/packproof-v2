# Identifier enrichment server integration

Migration `060_identifier_enrichment` is additive. It pins optional policy on newly issued ordinary packing sessions, adds an indexed read model, and adds append-only observation, decision and checkpoint rows. There is no old-manifest regeneration or evidence down migration. Capture references use composite session/Proof/actor ownership. Recovery snapshots now retain identifier rows and the intake ancestors referenced by capture sessions; restore ordering supports those dependencies. The alias index is rebuildable and does not grant access after credentials/connections are lost during restore.

## Rollout and kill switch

All values default off. An enabled session requires an ACTIVE connection owned by the recording account, an exact `IDENTIFIER_TENANTS` entry and a permitted `IDENTIFIER_SURFACES` entry (`ANDROID`, `IOS`, `WEB`, comma separated; `WAREHOUSE` remains reserved for a future adapter). `IDENTIFIER_STORES`, when set, additionally limits connection IDs.

iOS capture clients declare `surface: "IOS"` alongside `client: "NATIVE_CAMERA"` for direct recording and intake handoff requests. Capture-engine intents propagate their capability surface. Apply migration `066_ios_capture_surfaces.sql` before deploying this API; it extends the allowed policy and study-device values without rewriting prior sessions. A pinned policy cannot change on retry. `IOS` must be explicitly added to the operator's eligible surface list to enable optional item enrichment; Android-only rollout configuration does not implicitly enable it on iOS. The surface remains a client declaration, never hardware-origin attestation.

- `IDENTIFIER_CAPTURE_ENABLED=true`: optional observation protocol.
- `IDENTIFIER_AUTOFILL_ENABLED=true`: exact authorized source resolution; also requires the review flag, so a known mismatch cannot be admitted without its review path.
- `IDENTIFIER_REVIEW_ENABLED=true`: source mismatch review. Enable with autofill for the material-review pilot.

Gate A deploys with every flag off. Gate B uses observation-only capture for an internal tenant. Gate C enables autofill/review only for authorized real-data pilot orders. Gate D requires device/browser qualification. Setting capture false stops newly admitted enrichment sessions; already pinned sessions retain completion and historical observations. No production qualification is claimed by `/capabilities`.

## Contracts and immutable boundary

Routes are documented in shared `backend/src/identifiers/types.ts` and exposed under `/proofs/:id/capture-sessions/:sessionId/identifier-observations`, `/identifier-decisions`, and `/identifier-checkpoint`. Send `recordingRef=sessionId`. Raw text is limited to 4 KiB; batches to 50 events / 128 KiB; sessions to 512 observations with 16 slots reserved for shipping and SKU/tracking ambiguity. Sequence and event IDs are unique within the session. Different retry contents return 409. Observations cannot rebind a transaction or register a carrier tracker; only a server `SHIPPING` route allows the existing shipping command to proceed.

Checkpoint sealing accepts explicit COMPLETE, PARTIAL or UNAVAILABLE coverage. COMPLETE requires all sequences acknowledged and no omissions. Any known material mismatch must have an attributed decision. If optional checkpoint service is unavailable, the existing attestation/finalization barrier creates a stable PARTIAL/UNAVAILABLE checkpoint under its locks, while enforcing every already acknowledged material conflict. This adds no required scan or additional biometric challenge. The existing attestation context digest incorporates checkpoint hashes only when present; historical payloads stay compatible.

New observations after the checkpoint or a prepared manifest are clearly supplemental. Finalized records append a signed supplement when the configured signer is available. Delayed observations are never silently added to the original checkpoint, manifest or seller authorization. Recovery receipts continue through the existing durable outbox.

## Real data and honest availability

Exact identifier aliases come from authorized API intake snapshots and current commerce source revisions. SKU case, punctuation and leading zeros remain intact; validated GTINs normalize through the shared core. Duplicate variants stay ambiguous. Product candidates are read-only at `/me/intake/identifier-candidates` and always require explicit existing order selection.

Shopify's existing `read_orders` tokens continue to work unchanged. The optional ProductVariant barcode/product/variant fields are added to the existing order queries only when the connection already has `read_products` or `write_products`. This release does not silently request a new permission or add per-frame API requests. Missing product scope therefore means available imported SKUs can resolve, while missing GTIN mappings remain unavailable. eBay/Etsy keep the identifiers actually supplied by their existing order APIs. No public product database, paid barcode lookup, cloud frame service, new carrier subscription or operational demo data is added.

## Disclosure

The participant canonical Proof projection has optional `identifiers`; each observation includes its authorized `evidenceId` and approximate/exact source timing. Existing public grants expose no identifier category. For the existing disclosure preview/grant endpoints, `SHARED_PROOF` may explicitly opt in with `itemIdentifiersReviewed:true`. `CLAIMS_REVIEW` may explicitly include `itemIdentifiers` in `fields`, alongside order and evidence. Exact preview-hash approval remains required. `/grants` and `/reuse` return `itemIdentifiersReviewed` from persisted scope so clients can safely reuse cached links. Opted-in projections remove raw text/bytes and review reasons/actor IDs, and restrict observations to selected evidence. This scope also applies when the existing Zendesk claims launch inherits a grant.

## Verification and limits

Focused tests cover policy pinning, source matching, UPC/shipping separation, case-sensitive SKU ambiguity, two-store isolation, replay/sequence conflict, explicit order selection, material review, stale decisions, optional outage, supplemental observations, signed finalization immutability, disclosure consent, unsupported QR suppression, scoped HTTP access and a 10,000-row index benchmark. Combined focused gate: 53 passing tests across six affected files; backend typecheck passes. The 10,000-row / 30-sample benchmark recorded warm lookup p95 1.83 ms in PGlite and is not a production latency or device qualification result. Physical Android camera, browser performance and live real-product/connected-store pilot gates remain independent release requirements.
