# Populated desktop Home priority correction

The October 11 primary and measurement releases preserved the populated desktop Home hero with a fixed Packing Station action. An account with eligible unfinished Proofs could therefore see a fresh-packing prompt ahead of recovery or continuation. This follow-up keeps the desktop layout, navigation, metrics, recent records, status panel and fulfillment queue, and applies the existing deterministic task selector to the hero.

Wide-screen web supplies current summary permissions, local recordings and upload jobs, fulfillment assignments and reconciliation state. Usable saved review and upload intervention outrank incomplete Proofs; ordinary uploads remain passive. Electron adapts its existing account-bound job states to the same priorities. Desktop review takes place inside the guarded Packing Station; an interrupted staging journal is offered as upload recovery, not as a finished reviewable recording. Create Proof remains available, and the prior presentation remains available through the existing build flag.

Focused recommendations keep a still-eligible target stable. On selection, web reloads local work and authorized canonical Proof state. Recovery uses the existing wide-screen Uploads route. Electron checks current account-local jobs and uses a new, strictly typed, account-bound `proofs.current` read for server actions. That read intentionally has no offline cache fallback and checks the expected account before and after the API request. Existing cached reading remains available elsewhere. A finalized or newly restricted target opens its record; failures and late responses after account/page changes cannot open an old capture target. Local upload review remains possible offline.

## Verification and integration

Implementation starts from main `f2dc885c973bdf9a18c89f386dbcfdd89f349504` in an isolated worktree. It changes no backend, native-mobile, migration, evidence, billing, signing or release-version contracts.

- Focused web checks cover recovery priority, incomplete Proofs, healthy uploads, viewer permissions, focus stability, unknown/reconciliation states, current finalization, rejected access and sign-out during a pending request.
- Desktop checks cover deterministic priority, local recovery, passive uploads, unknown states, changed targets/accounts, missing recovery journals, current jobs appearing during validation, and strict uncached IPC account/argument checks.
- Web and desktop full suites and production builds are required before review. Local build success does not establish signed installer or physical-device results.

The follow-up is a separate reviewable PR. Do not merge while the measurement backend and exact-source iOS release still depend on main remaining at `f2dc885`. After those operations finish, review/merge this correction, complete its CI checks and rebuild the web and desktop artifacts from the resulting exact source. Website publication and installer publication are separate receipts; this document does not claim either occurred.
