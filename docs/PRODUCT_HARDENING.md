# Product hardening — September 4, 2026

Baseline: `b293a08590768d6a9c1cffe3d76b3613e7d71c1d` on `main`.

This pass repairs existing commerce, sharing, account, and evidence workflows. It does not change the canonical manifest format, evidence commitment rules, optional-counterparty policy, or existing finalized Proofs.

## Backend and release reliability

- Apply the configured CORS policy before every router, including email subscription and webhook routes. Return private/no-store, no-referrer, and nosniff headers. Invalid JSON and oversized bodies use safe JSON errors.
- Serialize subscription creation per Proof. Atomically claim outbox deliveries with a unique token and a five-minute lease before contacting SMTP. A stale worker cannot acknowledge a replacement claim.
- Retry failed deliveries with exponential backoff, capped at eight claims. Exhausted rows remain available for investigation in `proof_notification_outbox` with `attempt_count >= 8` and `sent_at IS NULL`. Provider error payloads are not stored in `last_error`.
- Check subscription preferences and link revocation/expiry before dispatch. A separately revoked viewing link stops new email delivery. An email already handed to SMTP cannot be recalled.
- Handle SMTP socket errors throughout the conversation; close failed sockets and cap total delivery time at 60 seconds. Delivery tests use fake transports and do not send email.
- Coalesce maintenance per API instance. Proof mutations reconcile that Proof; ordinary traffic still runs the periodic catch-up sweep. No reconciliation runs when delivery is disabled.
- Apply each database migration and its registry record in one transaction. Lock the migration registry while checking/applying; use a transaction-scoped advisory lock to serialize creation of the registry itself. Migration failure rolls back partial schema changes.

Migration `023_notification_delivery_leases.sql` adds two nullable outbox columns. Deploy it through the normal startup migration runner. Keep the columns if rolling the application back; older dispatchers do not honor leases, so the concurrency guarantee applies after all email workers run the new code. Future migrations must use operations supported inside a transaction; concurrent index creation needs a separate deployment procedure.

SMTP delivery remains at-least-once: a process can exit after a provider accepts a message but before the database records success. Leases prevent ordinary simultaneous dispatch; they cannot make SMTP and PostgreSQL one atomic transaction. Live delivery still requires the existing SMTP and tracker-link-secret configuration.

## Accurate shared Proofs

- A packing milestone requires qualifying commerce fulfillment evidence or a committed custody packing observation. An unrelated item photo or generic seller attachment no longer implies packing.
- A return-delivery observation is not treated as the original outbound delivery.
- `STATUS_ONLY` omits item title, order reference, shipment identifiers, and detailed milestone locations from the tracker. Summary links retain their intended detail.
- First-access auditing and view-count updates share a transaction, with a locked access-link row. Expired rate-limit entries cannot accumulate without a bound.
- The web tracker distinguishes an unavailable/revoked link from a temporary outage. It clears the visible Proof after a definitive access failure, retains the last successful view with a warning during outages, and offers retry. Polls do not overlap and pause while the document is hidden.

## Evidence reading and export

Authenticated participants can open committed video, raster images, or audio from the web Proof record and download original bytes. Media loads only when requested. Object URLs are released when closed or unmounted. Integrity metadata is available under an expandable detail section.

`GET /proofs/:id/package` returns an attachment named `packproof-<proofId>.json` using the existing `packproof.proof-package.v1` schema. It requires participant authorization and a finalized manifest, checks the stored SHA-256, and exports the same canonical record on retry. The package contains the manifest and digests; media is downloaded separately. Current manifests remain explicitly unsigned (`signature: null`); this change does not introduce a signing service or claim origin authentication from a hash alone.

## Account and interface recovery

- The web API uses the configured API origin when there is no session, so public links work on a separately hosted frontend.
- Web Cognito sessions refresh before a known expiration. Concurrent callers share one refresh; a refresh completing after sign-out or account change cannot restore the old account. Sessions without a known expiration keep their existing behavior.
- Workspace reads ignore responses from abandoned routes/accounts. Returning to a visible tab or reconnecting refreshes server-owned data. Failed list/Proof reads have retry controls.
- JSON commands on web and mobile have a 30-second deadline; web account calls are also bounded. Media downloads allow two minutes; direct upload requests allow ten minutes. No command is automatically repeated after a timeout. Existing durable capture retry state is preserved.
- Android's default `All` role filter now displays pending invitations. Both clients use the same invitation filtering function.
- Search distinguishes no matches from an empty account, displays active filters, and offers a reset. Added result counts, web loading placeholders, clearer evidence sections, accessible keyboard tab navigation, and visible clipboard feedback. New styling uses the existing light/dark tokens and respects reduced motion.

## Validation and remaining release checks

Regression coverage includes CORS on successful and failed intercepted routes, malformed request bodies, scoped redaction, authorized package export and independent digest verification, concurrent subscription creation and delivery, expired claims and retries, SMTP disconnects/deadlines, migration rollback/concurrency, mobile timeouts, session refresh/sign-out races, evidence lifecycle, search reset, and public-link revocation/outage behavior. The existing commerce, custody, integrity, and capture suites remain the release regression gate.

Local automated checks do not replace the live S3/Cognito/staging integrations, physical Android testing, or a new signed AAB. Those environment-dependent checks remain in [RC1_RELEASE_GATE.md](RC1_RELEASE_GATE.md). No credentials, infrastructure settings, paid builds, or live customer emails were changed by this pass.
