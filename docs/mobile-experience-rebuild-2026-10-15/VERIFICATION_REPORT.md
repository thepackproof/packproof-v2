# Android rebuild — internal review verification

Prepared 15 October 2026. **Android code and an installable internal review artifact are delivered; the complete development plan is not accepted or released.** G2 native/production parity, G3 physical acceptance and G4 exact-build authorization remain open. No PR was merged and no store submission or production deployment was performed.

## Frozen source and review stack

Artifact and automated validation source: `fbc1821ce687f95052d1e11df46e3cb55bff4977`; tree `002ce9d0c1dad425e8057af0d35c5c3fa588e71d`. The checkout was clean before and after both the complete local regression run and guarded build. The dossier is published separately on `ux/android-rebuild-dossier`, preserving the frozen artifact branch and its CI run. Dossier-only commits are not claimed to have been compiled into this artifact.

Baseline: `e71461caae5075adaa7b741a3ceec3cd2d9b7d3a`. Approved G1 revision: `G1-2026-10-15-r1`, prototype SHA-256 `bf8227135610f54c266b6f20b3bc5a6cabb50f213d10f2382b17e0c84335e724`. The founder's “Excellent, proceed” authorized implementation; it did not authorize release.

| Draft PR | Slice | Code tip |
| --- | --- | --- |
| [#89](https://github.com/thepackproof/packproof-v2/pull/89) | Shared Android foundation and navigation | `012113998823157c9bc7d0bf4f1b693526920acc` |
| [#90](https://github.com/thepackproof/packproof-v2/pull/90) | Manual Proof, capture and review | `9147747f31620a5c4ca68a5fb03a5ca7293b7bef` |
| [#91](https://github.com/thepackproof/packproof-v2/pull/91) | Exact saved-original recovery and Updates | `fd68f34324b8265effe879e7d9f0a2ef89a5aae8` |
| [#92](https://github.com/thepackproof/packproof-v2/pull/92) | Capture landing and scan/order handoff | `576290821a1fecfdb1d4298df6c7c8597027663b` |
| [#93](https://github.com/thepackproof/packproof-v2/pull/93) | Evidence, history, shipment and account response guards | `dfdf686faa010b126cb2024b1557f0f7dc8b2fae` |
| [#94](https://github.com/thepackproof/packproof-v2/pull/94) | Compact account and optional integrations | `cfbc164f981208f8d66144331ea9ddb95b434f16` |
| [#95](https://github.com/thepackproof/packproof-v2/pull/95) | Internal build procedure, CI guards and dossier | `fbc1821ce687f95052d1e11df46e3cb55bff4977` |

Each PR targets the preceding slice, beginning with the frozen G1 branch. Existing capture coordination, journals, hashing, authorization, server finalization and preservation rules remain the owners. Android composition is behind `EXPO_PUBLIC_PACKPROOF_ANDROID_TASK_FIRST`; shared account-isolation fixes intentionally guard both platforms. The main production profile and backend source were not changed.

## Automated verification

[final-mobile-validation.json](final-mobile-validation.json) records the clean-source local run using Node 22.14.0. All 15 validation groups passed: **492 passing test executions, zero failures, one expected skip** across 493 executions. Some existing tests execute in multiple groups; this is not a count of unique tests. Mobile TypeScript passed.

The run covers build security, iOS source guards, Proof record, study timing, intake, redesign, recovery, UX recovery, first Proof, identifiers, API contracts, Android task-first behavior, local review build guards, and navigation/share caching. The 110 task-first executions and eight local build guard tests are included in the total. The skip requires a generated Xcode project, which was not produced for this Android task; no iOS native build is claimed.

The first full run exposed a Node 22 ESM worker-loader incompatibility before the adversarial upload assertions. The final test-only commit loads the same TypeScript implementation through `createRequire`; it preserves the timeout and malformed-host cases. The affected 29-test group passed on Node 22.14 and Node 24.19, then the entire clean-source suite passed again. No assertion was removed or weakened.

Exact-source GitHub CI: [run 38721481182](https://github.com/thepackproof/packproof-v2/actions/runs/38721481182). The accompanying `final-ci-status.json` records the observed job states and retrieval time. Mobile, PostgreSQL release invariants, Web, dependency audits, source secret/release tooling and deployment guards passed. Do not infer completion for a job recorded as pending or in progress. The Android-attestation workflow job was skipped; the local full APK build compiled the native modules. The separate [iOS workflow](https://github.com/thepackproof/packproof-v2/actions/runs/38721481210) passed its release-policy guard but skipped both native compilation and signing.

## Verified internal artifact

| Property | Verified value |
| --- | --- |
| Filename | `packproof-1.0.1-66-fbc1821ce687-local-review-debug-signed.apk` |
| Size | 84,401,399 bytes |
| SHA-256 | `9b02b11a30e9bdea1ca3c5cebcebefb1556c29a151ddc50f3d34d4a6527a416b` |
| Package / version | `com.packproof.mobile` / 1.0.1 (66) |
| Build | `mobile-ux-review`, release variant, embedded JavaScript |
| Signer | Generated local debug key; not Play release signing |
| Signer certificate SHA-256 | `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` |
| Review targets | ARM64 Android device or x86_64 emulator; other packaged dependency ABIs are not qualified |
| Device installation / execution | NOT RUN |

The build completed in 10m28s: 446 Gradle tasks, 422 executed and 24 up-to-date. It regenerated the ignored Android project from committed Expo configuration, disabled ignored dotenv inputs, and verified source cleanliness. The Node 22.14/JDK 17/SDK 36 toolchain used the pinned NDK and CMake. Manifest identity, APK signature against the generated certificate, ZIP CRC, source SHA in both compiled JavaScript and packaged Expo config, internal-review marker, absence of packaged credential files, and 16 KB ELF/ZIP alignment passed. Subsequent independent calls rechecked full file size, hash, archive integrity and provenance with no truncation.

See [build-receipt.json](build-receipt.json), [independent-verification.json](independent-verification.json), [page-size.json](page-size.json) and [SHA256SUMS](SHA256SUMS). These are generated artifact evidence, not physical-device results. The receipt's distribution statement describes the build procedure at creation; the APK and receipt were subsequently attached for internal review, without installation or store publication.

**Install only on a clean, compatible 64-bit spare device/emulator.** This same-package debug-signed APK cannot replace a differently signed Play installation. Do not uninstall an existing PackProof installation or clear its media to install it. Optional production receipts are disabled in the existing review profile. An authorized production-equivalent internal artifact and receipt-enabled device run are still needed before G4.

[artifact-abi-inventory.json](artifact-abi-inventory.json) records the actual libraries. The APK is not universal: ARM64 and x86_64 each contain all 15 native libraries, while `armeabi-v7a` and `x86` contain 14 dependency libraries and omit required `libexpo-modules-core.so`. Do not install this artifact on 32-bit devices. Broader distribution needs an explicitly filtered or complete ABI build and its own verification; this artifact's review scope remains 64-bit only.

A source audit found no ordinary-confirmation APK certificate allowlist; account/Proof/media-bound P-256 verification remains enforced. Native strong-biometric signing remains required, and the server explicitly does not independently verify the client biometric/hardware claim. Research platform assurance has separate certificate/Play gates. None of this establishes deployed backend configuration, Play recognition or successful end-to-end device completion. See `mobile/src/attestation/seller-attestation.ts`, `backend/src/domain/attestation-authorization.ts`, `mobile/src/research/platform-assurance.ts` and `backend/src/rnd/platform-assurance-service.ts`.

## Outstanding acceptance work

The following are open qualification requirements, not silently waived tests. Owners are roles; individual operators and fixture accounts still need assignment. The current executable protocol is [NATIVE_ACCEPTANCE_MATRIX.md](NATIVE_ACCEPTANCE_MATRIX.md).

| ID | Release-blocking evidence still required | Owner / state |
| --- | --- | --- |
| QA-01 | Installed G0 identity, matching S01–S09 native before/after screenshots, actual baseline/after performance and wrong taps | QA / NOT RUN |
| QA-02 | All A01–A15 and B01–B15 on physical Android: camera, strong biometrics, account/role isolation, offline/force-stop, two devices, authoritative server outcomes | Engineering + QA / NOT RUN |
| QA-03 | Native component/screen atlas at compact widths through 200% text, both themes, all-key-flow TalkBack/keyboard/switch/reduced-motion checks | QA / NOT RUN |
| QA-04 | Approved native screenshot baseline and CI rejection of unapproved differences | Engineering + founder / NOT IMPLEMENTED; baseline NOT RUN |
| QA-05 | Five separate complete journey recordings and five unfamiliar users meeting the plan's unassisted gates | QA + target users / NOT RUN |
| QA-06 | Production-equivalent optional-receipt parity and compatible UI-only rollback preserving queued originals | Engineering + QA / NOT RUN |
| QA-07 | Current capability parity ledger, defect severity/owner/retest evidence, staged rollout and metric owners, founder live exact-build review | Engineering + QA + founder / NOT RUN |
| G4 | Explicit exact-build public release authorization | Founder / NOT REQUESTED, NOT GRANTED |

There is no connected physical Android device, qualified installed-build fixture or recruited user panel in this execution environment. Static prototype renders and model tests cannot replace those observations. Source capability audits are not native parity sign-off. No native screenshot baseline was fabricated, no measured usability improvement is claimed, and no public rollout should begin from this packet alone.

Review corrections already included in source address off-screen recording controls, optional-label wording, consent/source binding, stale deep-link acknowledgment, exact-original selection, unread acknowledgment, account-switch response isolation, and integration-sheet error/focus handling. Device verification of these corrections remains part of QA-02/03. G1 visual deviations and reuse decisions are recorded in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md); the G0 capability ledger remains in [G0_NAVIGATION_AUDIT.md](G0_NAVIGATION_AUDIT.md).
