# Disclosure, buyer receipts, and source thumbnails

Implementation date: September 5, 2026. This is a first release over the existing Proof, participant, access-link, commerce-receiver, and notification outbox models. It does not change canonical evidence or finalization. Production configuration and human recipient/device pilots are release gates, not results of local tests.

## Recipient scope

`domain/disclosure.ts` centralizes guest projection and media authorization. All token reads resolve the current nonexpired, nonrevoked access link and latest append-only scope version. Participant access continues through existing participant checks. The response includes policy version, scope version, recipient purpose, and the exact projection hash. There are no guest raw manifest, private account, financial amount, full tracking number, address, free-text location, arbitrary statement, or original-storage URL fields.

Every recipient view contains `status`. Optional field groups are `order` (item title only), `shipping` (structured sourced milestones and carrier only), and `evidence` (the explicitly selected representations). Standard custody observation labels are generated from event types; free-text descriptions are withheld. Buyer-reported receipt is separate from carrier-reported delivery. Opening a link or email-scanner request does not constitute receipt acknowledgement, acceptance, or waiver.

Existing STATUS_ONLY/SUMMARY/EVIDENCE_VIEW links remain functional as conservative structured views. Their historical broad scope does not authorize unreviewed source bytes. New explicit ORIGINAL selections require purpose CLAIMS_REVIEW plus `originalsReviewed: true`. Buyer and public-sample media must be a server-rendered reviewed opaque-mask derivative. These are views of one integrity standard.

POST `/proofs/:id/disclosure/preview` accepts `{purpose, fields, media, originalsReviewed?}`. Media entries contain `{evidenceId, representation: 'DERIVATIVE', derivativeId}` or the explicitly reviewed ORIGINAL variant. POST `/grants` adds the returned `previewHash`; server recomputes it and rejects changed content with DISCLOSURE_PREVIEW_CHANGED. PATCH `/grants/:linkId` appends a scope version using the same preview contract. Existing access-link DELETE revokes future reads. Preview and delivery use the same projector. Shipping can advance after preview, and every delivered result identifies its own view hash.

Media GET checks the grant before storage access and again before returning bytes. Every Range request repeats authorization. Delivery uses private no-store, no-referrer, nosniff headers and single byte-range support. No public redirect or reusable object-store URL bypasses revocation. Files already downloaded and screenshots cannot be recalled. A scoped package is a separate disclosure artifact with explicit omissions, never a purported full canonical manifest.

## Redactions and thumbnails

POST `/proofs/:id/disclosure/redactions/:evidenceId` takes normalized opaque rectangles `{masks:[{x,y,width,height}]}`. Server FFmpeg renders masks on every frame, removes audio, subtitles, data streams, metadata, chapters and original thumbnails, and creates a separately hashed object. At most two renders run concurrently per process; inputs/outputs are bounded to 100 MB, render time to 120 seconds, and retry attempts to three. Duplicate transforms reuse their durable derivative row. A crashed pending render may be retried after its lease expires. A failed render remains failed and never delivers the original as fallback.

GET `/redactions/:derivativeId/media` is seller-only review. POST `/redactions/:derivativeId/approve` requires the exact derivative SHA-256. Only a READY opaque-mask result can become REVIEWED; reviewed lineage is immutable at the database layer. This is a manual review step, not automatic assurance that every sensitive region was selected. New masks require a new transformation record. Silenced redacted playback is explicitly labeled as a copy.

POST `/thumbnails/:anchorId` queues an optional recording thumbnail and returns 202 plus a durable derivative ID. The job records anchor ID, source SHA-256/version, elapsed selection and transform version. GET `/thumbnails` returns job status; GET `/thumbnails/:derivativeId/media` requires participant access. Thumbnail processing verifies actual duration with FFprobe, emits a single original frame scaled for viewing, and strips metadata and other streams. No frame interpolation or reconstruction occurs. Unredacted thumbnails cannot be approved through the redaction API or shared via guest routes.

`startMediaWorker` processes bounded thumbnail jobs with database leases, at most three attempts, and explicit failure status. A failed job leaves chapter seeking and original playback available. Derivative jobs store source and output hashes; originals remain unchanged. Derivative access remains tied to the committed source identity and current grant. Deployment retention handling must remove derivative objects alongside source objects when a deletion policy requires it.

## Buyer notification consent

Cognito email contacts enter `user_verified_contacts` only from server-verified `email_verified` ID-token claims. The notification target must match exactly one verified contact belonging to the Proof's existing BUYER or invited commerce receiver. That buyer must explicitly opt in using POST `/proofs/:id/disclosure/receipt-preference` with `{optedIn:true}`. Opting out cancels pending email without changing the seller Proof.

Existing POST `/proofs/:id/email-subscriptions` now requires seller authority and that verified, opted-in buyer. Optional `recipientGrantId` binds the notification link to the reviewed BUYER_RECEIPT grant. Its current scope, expiry and revocation are rechecked on every view and media request. Reusing an active subscription with a newly selected grant updates that association and deduplicates its scope-update event. Narrowing or revoking the reviewed link also governs its emailed copy; changing the source purpose away from BUYER_RECEIPT blocks that copy. Notification links expire after 30 days. Preferences, delivery status, revocation and recipient unsubscribe remain on the existing subscription/outbox path. Email subjects and bodies omit order identifiers, item descriptions, addresses, tracking numbers and financial details; they contain only a generic sourced milestone and scoped receipt URL.

Unique subscription/event identity prevents duplicate enqueue. Database leases prevent concurrent workers owning one delivery. Five failed attempts exhaust the job; stored failure codes omit provider text and customer data. Dispatch rechecks verified contact, current consent and valid access before sending. SMTP has no provider idempotency key, so a process crash after provider acceptance but before marking the outbox sent can still cause a duplicate retry. This is bounded at-least-once delivery; no exactly-once claim is made.

## Independent controls and validation

- `PACKPROOF_REDACTION_ENABLED=false`: stop new manual redaction work.
- `PACKPROOF_REPLAY_THUMBNAILS=false`: stop thumbnail queue/processing.
- `PACKPROOF_MEDIA_WORKER=false`: stop background thumbnail worker.
- `PACKPROOF_RECEIPT_NOTIFICATIONS=false`: stop email dispatch.

Core capture and participant evidence reads do not depend on these optional processors. Source tests cover role isolation, hidden fields, explicit original grant review, exact preview mismatches, grant narrowing, revocation, range authorization, real opaque render output, required review, failed-render no-fallback, thumbnail lineage/dedupe/participant-only delivery, buyer verification/consent and competing email workers. Remaining operational gates include S3/FFmpeg workload sizing, actual SMTP provider delivery, reduced-cost-device playback, manual redaction usability, and the five-unfamiliar-recipient pilot.
