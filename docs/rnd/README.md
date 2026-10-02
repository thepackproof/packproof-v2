# Trust infrastructure R&D

This experimental implementation follows the October 2, 2026 executive/ASTRA plan on one branch, `rnd/trust-infrastructure-2026-10-02`, created from `main` at `a157356924bf4bf688e171c9ff223576fcb6ca3d`.

Production deployment, app-store/TestFlight/Play upload, desktop auto-update and public capability claims are not authorized. `config/rnd/research-build.json` is a committed distribution interlock; branch renaming or copying the source onto main does not remove it.

- [Local development and verification](LOCAL_DEVELOPMENT.md): reproducible private startup, research viewers, benchmarks and offline verification.
- [Repository audit](REPOSITORY_AUDIT.md): CORE-01 findings and release surfaces.
- [Baseline source inventory](baseline-source-inventory.json): exact protected-source hashes and locked dependency versions, taken from the baseline commit rather than the concurrently edited working tree.
- [Architecture and threat boundaries](ARCHITECTURE.md): additive integration and assurance separation.
- [Operations and rollback](OPERATIONS.md): local configuration, distribution denial, retention, consent, trust and kill switches.
- [Status ledger](status-ledger.json): every CORE and F-ticket, with engineering, qualification and release authorization tracked separately.
- [Implementation handoff](HANDOFF.md): delivered scope, measured checks and remaining external gates.
- [Final verification](validation/final-verification.json): exact commands and the resolved final regression result.
- [Qualification dependencies](QUALIFICATION.md): required physical, independent-operator and specialist evidence that software fixtures cannot supply.

Run the source-distribution gate with `node scripts/rnd-release-guard.mjs`; the current source must report `allowed: false`. Run its seven policy/workflow tests with `node scripts/rnd-release-guard.test.mjs`. `--enforce` additionally exits unsuccessfully on denial. These are local commands and make no network calls.

The reconciled ledger contains 60 tickets engineered within their documented local research scope and 11 tickets blocked on external qualification. The complete scientific plan is not qualified or released. The measured populations remain explicit: synthetic protocol results do not establish phone optics, liveness, hardware attestation, privacy certification or independent witnessing.
