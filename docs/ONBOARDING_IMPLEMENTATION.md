# Cross-platform onboarding

Adds a six-step tour over the real dashboard, Skip/Back/Next, direct Create Proof entry, Help & Support replay, and first-Proof guidance to Android/iOS, web, and desktop.

## State and analytics

Migration `075_onboarding.sql` marks existing accounts exempt and enrolls accounts created afterward. Authenticated `/me/onboarding` GET/POST routes own completion, version, resume position, and coaching dismissal. Updates accept validated actions, not arbitrary profile patches. Completion is monotonic; stale clients cannot reopen it. Client caches contain only account/environment-scoped pending actions, so an offline skip is retried after reopening. Server state is read before automatic display.

All clients use `packages/onboarding/model.ts`. Replay is session-only and does not send first-run events or reset coaching. Unknown future tutorial versions do not replay version 1 automatically. Future versions need explicit incremental step configuration.

`onboarding_events` deduplicates events by account/version/event/step. First-Proof milestones derive from the user's first transaction-bound Proof and its committed video/finalized state; client assertions cannot manufacture milestones. Milestone timestamps come from those records. Reads reconcile milestones on the next account refresh, including work finished in the background. `first_proof_recorded` means committed video, not an unpreserved camera stop. Capture coaching uses existing label-success/haptic feedback; local preservation guidance appears only when upload is underway/accepted. Completion guidance is acknowledged through View Proof or Dismiss guidance.

## Focused verification

- Backend TypeScript: passed.
- Backend onboarding tests: 3 passed (resume/skip, deduplication, validation, account isolation/exemption, first-Proof source records).
- Shared controller tests: 3 passed (offline skip/reopen, replay isolation, existing/future-version suppression).
- Web production build: passed.
- Desktop production-code compilation/bundling: passed; this is not a signed installer.
- Mobile TypeScript and Metro Android/iOS exports: passed.
- Real-device visual/camera acceptance and signed release builds: not completed in this environment.
- Browser visual check: unavailable; browser installation failed. No claim of visual acceptance.

## Release order

1. Deploy the additive database migration through the existing owner-role migration process, retaining the project's compatibility and runtime-grant checks. Runtime needs access to the new onboarding table. Do not reuse the hash-pinned desktop-074 operator for migration 075.
2. Deploy the API including the new authenticated routes. Check an existing exempt account and a newly registered account.
3. Publish the web client; build Android/iOS and Windows/macOS release candidates from this source.
4. Check the six spotlight positions, font scaling, reduced motion, skip/reopen, cross-device completion, replay, and one first-Proof flow on representative clients.
5. Promote verified signed packages through the existing app-store/desktop release process.

The AWS release check did not return a result in this session. No live migration, API deployment, signed installer publication, or store release is claimed by these checks.
