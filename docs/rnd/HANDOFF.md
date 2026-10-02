# Research implementation handoff

Branch: `rnd/trust-infrastructure-2026-10-02`, based directly on `main` at `a157356924bf4bf688e171c9ff223576fcb6ca3d`. All work is on this one branch. Implementation commit: `08892e142ad383680fd4b9cc085a272a69daa543`. The ledger and verification record refer to this exact source commit; the following commit records this handoff metadata.

The reconciled 71-ticket ledger contains **60 engineered within documented local research scope** and **11 blocked on external qualification**. There are no outstanding local integration rows. This does **not** mean the full scientific R&D plan has completed: physical experiments, independent review and pilot gates remain open. Release authorization is false.

## Delivered

- Additive immutable research evidence, detached signatures, strict canonical schemas, generated API client, authorization/consent, durable queue leases/recovery, admission budgets, corrections, exports and operational metrics. Existing finalized Proof root bytes remain unchanged.
- Research-only Android/iOS capture instrumentation, bounded passive luma and barcode-region selection, signed sidecars, native platform-attestation adapters and server validation. A live software encoder spike signs actual initialization/audio/video fragments while encoding. Native production recorders still report `FINAL_FILE_ONLY`.
- Real CPU optical/appearance/OCR/temporal/condition workers, trainable bounded event model, immutable enrollment, actual sparse COLMAP reconstruction, explicit missingness and per-channel comparison. No physical accuracy is inferred from the synthetic results.
- Mobile, web and desktop research review: original source attribution, intervals/gaps, comparison, visible geometry, exact-byte derivative review, signed participant corrections and export. Expiring revocable derivative grants deliver only approved bytes and are redeemed without placing tokens in URLs.
- Real still/video redaction; actual 4×4 and 8×8 RGB8 zero-knowledge transformation proofs with pinned verification policy; append-only transparency log, controlled test witnesses, inclusion/consistency checks, restore rehearsal and offline verifier.
- Actual Flower SecAgg+ orchestration, persistent DP accounting, consent/withdrawal, signed candidate registry, promotion/rollback gates, and mutually authenticated TLS transport with expiry and persistent restart admission. The measured TLS candidate failed utility and was not promoted.
- Separate local runtime and app identities, default-off feature controls, global kill switch, private test key initialization, fail-closed worker sandbox launcher and committed distribution interlock. Research CI uses no production credentials and does not deploy, submit or upload builds.

## Verification

`validation/final-verification.json` records commands and links to the measured feature reports. Final web tests: 29 passed; desktop: 21; mobile: 64 plus Android native: 4; generated client: 5; canonical contracts: 9. Backend combined regression ran 132 tests with 131 passing and one Android policy assertion during concurrent source finalization. The exact final Android policy suite was rerun: 29/29 passed. Later witness operations and kill-switch grant revocation received targeted regressions. The report preserves that sequence instead of presenting it as one clean combined run.

Backend, web, desktop, mobile types and actual Android Kotlin/Metro builds passed. Vision 28, privacy/witness 17, portable verifier 18 and federated 22 tests passed within their named scopes. The sidecar test exercises actual bytes through the worker, signed export and pinned-trust portable verification. Actual ZK proofs and six live fragment-protocol tests were executed. Counts overlap some backend integration reports and must not be summed as unique tests.

The actual macOS CI run successfully compiled the unsigned simulator app and Swift camera module with Xcode 16.4 / iOS Simulator 18.5. It did not run XCTest or a physical device. Cloud CI also passed a clean 122-test backend integration run and all five general research jobs. Exact run IDs and source hashes are in `validation/ci-results.json`. The first Android cloud attempt failed before Kotlin compilation because its setup action requested the removed SDK package `tools`; the corrected workflow explicitly requests Android 36 and the previously validated command-line tools. Its follow-up cloud run passed actual Kotlin compilation, JVM tests and Metro bundling. All five general research CI jobs also passed again. The Linux execution host rejected the namespace mount needed for Bubblewrap, so OS decoder containment remains unqualified. Source-reviewed research Docker configuration was not built on this host.

## External work still required

The committed exact 240-label/60-carton manifest has **zero collected physical specimens**. Device optics/repeatability, copy/transfer/replay/damage experiments, feature-on/off continuity/thermal/storage trials, blind reviewer studies, real app-attestation enrollment and permitted native incremental recorder callbacks require hardware and authorized data. Active illumination/focus/exposure requires independently qualified safety/control profiles before activation. Native ROI ranking does not substitute for a camera-control driver.

There are **zero independent witness operators** and **zero independently consented federated partner organizations** in these measurements. The two test witnesses and all synthetic training participants are controlled locally. Stronger distributed-noise coordinator privacy remains unsupported; the central-DP baseline discloses pre-noise aggregate visibility. Cryptographic/privacy/security/safety review, representative cost/latency studies and consented pilots remain unperformed. No production deployment or distribution was performed.

Use [local development](LOCAL_DEVELOPMENT.md) to reproduce the isolated runtime and [status ledger](status-ledger.json) for each ticket's code, commands, population, measured output and next dependency. The source marker blocks distribution even if this branch is renamed or copied onto `main`.
