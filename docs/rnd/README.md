# Trust infrastructure R&D

This experimental implementation follows the October 2, 2026 executive/ASTRA plan on `rnd/trust-infrastructure-2026-10-02`, created from `main` at `a157356924bf4bf688e171c9ff223576fcb6ca3d`. The October 11 follow-up is developed on `rnd/trust-completion-2026-10-11` and reviewed into that research branch through PR #69. It does not merge the experimental source into production.

Production deployment, app-store/TestFlight/Play upload, desktop auto-update and public capability claims are not authorized. `config/rnd/research-build.json` is a committed distribution interlock; branch renaming or copying the source onto main does not remove it.

- [Local development and verification](LOCAL_DEVELOPMENT.md): reproducible private startup, research viewers, benchmarks and offline verification.
- [Repository audit](REPOSITORY_AUDIT.md): CORE-01 findings and release surfaces.
- [Baseline source inventory](baseline-source-inventory.json): exact protected-source hashes and locked dependency versions, taken from the baseline commit rather than the concurrently edited working tree.
- [Architecture and threat boundaries](ARCHITECTURE.md): additive integration and assurance separation.
- [Operations and rollback](OPERATIONS.md): local configuration, distribution denial, retention, consent, trust and kill switches.
- [Status ledger](status-ledger.json): every CORE and F-ticket, with engineering, qualification and release authorization tracked separately.
- [Implementation handoff](HANDOFF.md): delivered scope, measured checks and remaining external gates.
- [October 2 verification](validation/final-verification.json): historical commands and results for their recorded source.
- [October 11 follow-up verification](validation/2026-10-11-follow-up.json): current changes, exact source/CI receipts, and explicit reuse of unchanged inputs.
- [Qualification dependencies](QUALIFICATION.md): required physical, independent-operator and specialist evidence that software fixtures cannot supply.

Run the source-distribution gate with `node scripts/rnd-release-guard.mjs`; the current source must report `allowed: false`. Run its policy/workflow tests with `node scripts/rnd-release-guard.test.mjs`. `--enforce` additionally exits unsuccessfully on denial. These are local commands and make no network calls.

The October 2 ledger recorded 60 tickets engineered within their documented local research scope and 11 blocked on external qualification. The current [handoff](HANDOFF.md) and [ledger](status-ledger.json) preserve that dated assessment and reconcile follow-up engineering separately. The scientific plan is not qualified or released. Synthetic protocol results do not establish phone optics, liveness, hardware attestation, privacy certification or independent witnessing.
