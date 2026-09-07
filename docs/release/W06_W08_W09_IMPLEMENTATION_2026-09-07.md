# Order, tracking, recipient export and packing request implementation

This record describes source implementation and automated checks. It does not establish production provider authorization, live carrier behavior, portal acceptance, reviewer comprehension or commercial validation.

## W06: scoped order and tracking behavior

- One transaction retains its canonical Proof. `proof_parcel_scopes` records an immutable seller-declared single outbound parcel, its complete positive item allocation and a digest of the authorized order quantity snapshot. Locked allocation rejects duplicate item entries, quantities above/below the order snapshot, multiple parcels, returns and free-text override attempts. A subsequent order quantity change blocks further capture against that allocation.
- Capture gates reject known provider partial/split orders, multiple fulfillment packages, insufficient/unknown item quantities and mismatched package allocations. Multi-parcel, replacement and post-recording relabel workflows remain excluded until their allocation/revision tests are implemented and passed. They are not flattened into a complete single shipment.
- `capture_label_observations` persists decoded labels independently of accepted association, including rejected wrong-order labels. A distinctive barcode identifies a carrier pattern, not the correct order. A first label without expected tracking requires explicit confirmation. Matching an existing tracking number remains automatic. Carrier verification remains separately attributed.
- Provider event uniqueness is scoped to transaction, provider and source event ID. Historical rows remain immutable; reused tracking does not globally reserve a number or move earlier observations to a later Proof. Existing immutable transaction shipping and connection bindings define the single-parcel shipment epoch; a new parcel epoch cannot be silently substituted.
- Shippo webhook bodies are untrusted notifications by default. Only a bounded digest/inbox record is persisted, coalesced to at most one hint per transaction per five-minute bucket. No payload event is imported. The persistent worker performs authenticated API retrieval, checks carrier, tracking and test/live environment, then imports provider observations. Duplicate, forged and irrelevant hints do not create evidence or reveal whether a private order exists. Periodic reconciliation does not depend on an app visit. Terminal reports receive a 72-hour correction window.
- Opt-in HMAC verification is retained only for credentials explicitly marked `hmacProvisioned=true`; Shippo requires account provisioning for that mechanism. External label subscription registration can be enabled separately from HMAC because notifications can safely trigger authenticated retrieval.
- Configured signing runtime is forwarded to carrier import, allowing the supplement engine to append signed carrier additions without changing the original manifest. Historic unsigned events keep their original provenance.

## W08: destination-compatible, exact-byte review packets

`recipient-exports` extends existing signature case snapshots and approval rather than replacing the case pipeline. Signature snapshots/cases retain stable source-as-of supplement sequence and digest. The new job binds the source case digest, profile version, relevant frame selection, user narrative and actual destination deadline.

Profiles checked on 2026-09-07:

| Profile | Encoded constraints | Primary sources |
| --- | --- | --- |
| eBay payment dispute, US | JPEG/PNG, maximum five files, combined total strictly below 1,750,000 bytes; conservative target 1,600,000 bytes | https://www.ebay.com/help/selling/getting-paid/handling-payment-disputes?id=4799 ; https://export.ebay.com/en/fees-regulations-policies/seller-protection/handling-payment-disputes/ |
| Stripe payment dispute, US, Mastercard | Self-contained PDF, maximum 4,500,000 bytes and 19 pages; conservative target 4,000,000 bytes | https://docs.stripe.com/disputes/best-practices ; https://docs.stripe.com/disputes/responding |
| Stripe payment dispute, US, other networks | Same 4,500,000 byte total; PackProof applies a conservative 19-page product cap, not a claim that all networks impose Mastercard's page rule | Same Stripe sources |

Profiles require review after 2026-10-07. Unknown destinations/regions/networks and stale profiles are blocked. The merchant must check the actual case instructions and deadline; the profile registry is not a compliance or eligibility badge.

The leased worker produces fact pages and one to four full-frame stills, preserving original evidence SHA-256, the decoded source frame presentation offset, full original extracted PNG digest, FFmpeg version, transform recipe and output digest. It embeds facts, attribution, provider environment, declarations and material gaps inside the actual files. Facts explicitly distinguish carrier delivery from contents/recipient identity and identify missing address-match evidence. User-supplied supporting text remains labeled. Outputs do not depend on external video/audio/links.

The renderer uses local per-job files, fixed binaries/arguments, no shell, protocol/format allowlists, a credential-free child environment, CPU/address-space/open-file/output limits, single-thread decoding/encoding and timeouts. Its runtime needs FFmpeg, DejaVu Sans and `prlimit`. Runtime image/package pinning and container egress policy must be verified in deployment. Original videos stream into a verified private temp file using the exact preserved object version (up to the 250 MB admission limit); no whole original is buffered. Source frames below 480 pixels on the short edge and selections that cannot fit legibly are rejected; the UI must ask for relevance or an eligible alternative rather than shrink unreadably.

Approval requires review of the exact final files and explicit legibility confirmation. It binds the immutable artifact manifest and each encoded file digest. Request edits require a new job/review. Downloads read stored approved bytes and recheck digest and length; they never regenerate them. The ZIP contains a submission folder plus separate supporting text/verification receipt. The merchant uploads only the permitted submission files through the existing destination; PackProof does not file a dispute, pay a fee or promise an outcome.

## W09: optional buyer packing requests

The initial workflow supports an explicitly unverified user-provided order reference. It does not claim an integration-verified buyer-order relationship. The request is stored without creating a transaction, Proof, fee or evidence claim. Repeated normalized requests resolve to one relationship. New requests are limited to ten per buyer per day, reminders to one per day/three total, and unanswered requests expire after seven days.

Only the selected seller can accept or decline. Acceptance requires selection/confirmation of an existing seller-owned transaction and uses canonical create-or-get. It records attributed seller acceptance but does not silently grant buyer media access; existing reviewed invitation/disclosure controls remain the sharing boundary. Declining or ignoring shows “Packing Proof not provided,” never a fraud accusation. Captured status requires a finalized Proof, its durable signed recovery receipt, and committed qualifying packing video. A database FINALIZED status alone is insufficient. Viewing requests and responding does not bill either party.

## Required external evidence before gates can close

1. Production eBay application approval, account scopes and refresh behavior, a consented real order import and immutable external binding must be demonstrated.
2. Live Shippo credentials/subscription/account configuration and representative carrier events must be demonstrated, including a missed-update reconciliation. Tests and simulation tokens do not close that gate.
3. Correct parcel declaration/order relationship must be physically checked on supported devices. Full multi-parcel/relabel/replacement support remains gated.
4. Authorized actual eBay/Stripe case portals must accept the outputs; no fabricated disputes are created. File acceptance, still legibility, reviewer comprehension and handling-time benefit are separate measurements.
5. Reviewer frame labels/narrative must be checked against original footage. Hash correctness alone does not establish physical contents or claim eligibility.

Shippo primary sources checked 2026-09-07: https://docs.goshippo.com/tracking/tracking ; https://docs.goshippo.com/tracking/webhooks ; https://docs.goshippo.com/tracking/webhook-security . The documented HMAC setup requires Shippo account-manager/solutions provisioning; ordinary notifications safely use authenticated follow-up retrieval.
