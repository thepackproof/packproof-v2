# Cross-platform onboarding

Adds a six-step tour over the real dashboard, Skip/Back/Next, direct Create Proof entry, Help & Support replay, and first-Proof guidance to Android/iOS, web, and desktop.

## State and analytics

Migration `075_onboarding.sql` marks existing accounts exempt and enrolls accounts created afterward. Authenticated `/me/onboarding` GET/POST routes own completion, version, resume position, and coaching dismissal. Updates accept validated actions, not arbitrary profile patches. Completion is monotonic; stale clients cannot reopen it. Client caches contain only account/environment-scoped pending actions, so an offline skip is retried after reopening. Server state is read before automatic display.

All clients use `packages/onboarding/model.ts`. Replay is session-only and does not send first-run events or reset coaching. Unknown future tutorial versions do not replay version 1 automatically. Future versions need explicit incremental step configuration.

`onboarding_events` deduplicates events by account/version/event/step. First-Proof milestones derive from the user's first transaction-bound Proof and its committed video/finalized state; client assertions cannot manufacture milestones. Milestone timestamps come from those records. Reads reconcile milestones on the next account refresh, including work finished in the background. `first_proof_recorded` means committed video, not an unpreserved camera stop. Capture coaching uses existing label-success/haptic feedback; local preservation guidance appears only when upload is underway/accepted. Completion guidance is acknowledged through View Proof or Dismiss guidance.

## Focused verification

- Backend TypeScript: passed.
- Backend onboarding tests: 4 passed (pending-migration compatibility, resume/skip, deduplication, validation, account isolation/exemption, first-Proof source records).
- Shared controller tests: 3 passed (offline skip/reopen, replay isolation, existing/future-version suppression).
- Web production build: passed.
- Desktop production-code compilation/bundling: passed; this is not a signed installer.
- Mobile TypeScript and Metro Android/iOS exports: passed.
- Real-device visual/camera acceptance and signed release builds: not completed in this environment.
- Browser visual check: unavailable; browser installation failed. No claim of visual acceptance.

## Release order

1. Deploy this API before migration 075. Startup/readiness tolerate only the absence of this optional feature migration; all prior receipts and every present checksum remain mandatory. The onboarding endpoint returns 503 until its receipt exists. This lets the old task drain before the database inventory changes.
2. Run `scripts/onboarding-migrate.mjs --inspect`, then `--apply`, in the hash-pinned candidate image with owner components injected by the existing execution role. It checks the exact database, verified TLS, existing inventory, and supplied migration SHA-256; uses a separate expiring login for migration; grants only SELECT/INSERT on onboarding events to the existing runtime role; and cleans up the temporary login. Do not reuse the hash-pinned desktop-074 operator. Verify the new endpoint with a runtime login afterward.
3. Publish the web client; build Android/iOS and Windows/macOS release candidates from this source.
4. Check the six spotlight positions, font scaling, reduced motion, skip/reopen, cross-device completion, replay, and one first-Proof flow on representative clients.
5. Promote verified signed packages through the existing app-store/desktop release process.

Release status is recorded separately; these local checks alone do not claim a live migration, API deployment, signed installer publication, or store release.
