# Platform release, upgrade and rollback record

The user explicitly authorized completed webapp and Android publication to live production on October 24, 2026. Continue routine implementation, reversible preparation and release work within that scope without another conversational permission loop. Authorization does not substitute for candidate readiness. iOS and desktop implementation is in scope; production publication for those platforms is not asserted by this packet.

## Practical release decision

Go for remote candidate source review/CI and review-build preparation. Stop production activation until the real web journey, applicable physical capture/recovery/upgrade and exact artifact/provenance gates pass. The ADB server is running with zero attached devices: attach an authorized physical Android phone with its production installation and pending-work test setup. iOS requires Mac/signing/device access; Windows/macOS native package and hardware checks remain unexecuted. Current user authorization already covers completed web/Android publication.

## Current platform facts

| Platform | Implementation | Built | Visually reviewed in runtime | Device/native validated | Submitted | Live |
| --- | --- | --- | --- | --- | --- | --- |
| Webapp | Source implemented | Exact local web build passed; remote/hosted release candidate pending | Component gallery at 390/1280 reviewed; real journey/all states pending | Real capture/canonical journey not executed | Not executed | Not executed |
| Android | Source implemented; versionCode 72 configured | Compiler/focused checks passed; signed AAB not built | Installed visual review not executed | Physical recording/recovery/upgrade not executed | Not executed | Not executed |
| iOS | Shared source changed; native validation pending | Signed Mac/device build not executed | Not executed | Not executed | Not executed | Not executed |
| Windows | Renderer source implemented | Local compiler passed; native package not executed | Not executed | Not executed | Not executed | Not executed |
| macOS | Shared renderer source changed | Local compiler passed; native package not executed | Not executed | Not executed | Not executed | Not executed |

These labels describe this candidate only, not whether earlier product releases exist. Update each fact from actual results with exact identity and evidence; never collapse built, uploaded, under review, available and installed into one status.

## Required provenance before publication

For each platform record implementation branch/SHA/PR, hosted-source SHA/version where applicable, artifact filename and SHA-256, package/application ID, version/build, upload/signing identity, build provider/job and source binding, target backend revision/capabilities, feature flags, exact channel, rollout size and actual publication outcome. Retain a real Android .aab for the production package, not a ZIP described as an AAB. No credential or temporary signed download URL belongs here.

| Release fact | Webapp | Android |
| --- | --- | --- |
| Candidate source SHA / PR | Pending | Pending |
| Hosted source SHA / saved version | Baseline 5b454f836872cc9292b4b12fc4709674bb5c2d37 / version 62; candidate pending | Not applicable: native binary |
| Artifact / SHA-256 | Pending | Pending actual AAB |
| Package / version / build / signature | Exact candidate pending | com.packproof.mobile; live 1.0.1 (71), 100%; next code 72 configured; signing identity preserved but candidate artifact pending |
| Backend identity / capabilities | Observed production 399f306a2fdac37511c8659c73d5a059dd759b7a unchanged; affected capabilities pending | Same unchanged backend; affected capabilities pending |
| Flags / motion tiers / safe activation | Pending | Pending |
| Upgrade and recovery result | Not executed | Not executed |
| Release channel / rollout | Existing live site; exact publication pending | Explicit Play production; exact rollout pending |
| Publication / post-release evidence | Not executed | Not executed |

## Candidate gates

1. Reconcile exact source and the hosted/GitHub split; preserve auth, API bridge, public content and current backend additions.
2. Complete real web reference and installed Android reference, with canonical confirmation and all applicable critical states/controls. Resolve core visual mismatches before expansion.
3. Run affected focused checks and mandatory security/release/provenance checks. Attach actual command outcomes; never assume old build reports cover this SHA.
4. Exercise production-to-candidate upgrade with validated local original, interrupted capture, queued upload and confirmed record. Do not clear storage, uninstall pending work, change package/signature or delete unknown journals.
5. Verify same-operation reconciliation, exact account/Proof/take/operation isolation, failed/accepted retakes, consent invalidation and false-receipt prevention on relevant real devices.
6. Verify web auth/bridge/deep links, media access, library content and app-association routes after source reconciliation. Verify Android package, versionCode monotonicity, certificate, backend/flags and actual install upgrade.
7. Publish the exact reviewed candidate through the existing authorized release operators/channel. Inspect deployment/review/availability state and a post-release journey; report each truthfully.

Physical recording/interruption/lifecycle gates remain Not executed until an actual device result is attached. The absence of access is a concrete blocker, not a pass or a new request for broad authorization. Prepare everything independent first and specify the exact needed device/release access if it remains missing.

## Safe activation and migration

Prefer no evidence/database migration. Record current local journal and cache versions before necessary metadata changes. Any migration must be versioned, repeatable and interruption-safe while preserving owner/environment/Proof/take/operation identity. Unknown records get a repair path, never automatic deletion.

Activate shell changes on startup or a safe workspace boundary; never remount active capture or switch uploader ownership. Cosmetic effects may be disabled immediately without canceling work. Offline startup needs a safe cached/default policy. Preserve original files and queued work until existing confirmation/replacement cleanup rules permit removal.

## Actual rollback or forward-fix strategy

Choose and test the supported strategy before publication: a compatible presentation fallback, compatible forward fix, or permitted newer binary update. An old shell must understand pending new state before fallback. Store delivery may require a higher version rather than binary downgrade. Website saved version 61 from the historical marketing deployment is not an app rollback strategy and is not presumed current.

| Exercise | Expected result | Current result |
| --- | --- | --- |
| Disable optional motion while capture/transfer active | Same native/operation owner and identity; work continues | Not executed |
| Candidate restart during local/queued/confirming state | Readable originals and same-operation reconciliation | Not executed |
| Interrupted metadata migration | Repeat safely with no lost or cross-owner work | Not executed |
| Presentation fallback with pending work | Existing compatible reader and preserved actions | Not executed |
| Forward fix / store update | Same package/signing and readable pending journals | Not executed |
| Hosted rollback | Exact saved version/source, backend compatibility and retained app/public routes | Not executed |

Stop expansion for integrity/capture-critical defects, preserve diagnostics and evidence, and repair the affected owner. Monitor actual failures and task outcomes without private media/session recording or invented conversion/savings claims.


## Current local evidence and store baseline

Exact web build and 28 focused checks in 7 files passed with Vite 7.3.7 / Vitest 4.1.12 after clean dependency installation. Saved web/mobile audit reports contain zero reported vulnerabilities in their recorded scope. Native/desktop compiler diagnostics are zero with installed dependency fallbacks; native 61 earlier and 12 later focused checks, motion 4, theme/chronology 19, fonts 3 and token drift checks passed. These do not replace signed artifacts or physical acceptance. See acceptance.md and evidence/.

Verified Play account/package baseline: nericollin@thepackproof.com / com.packproof.mobile; latest uploaded and live code 71, version 1.0.1, 100% rollout, managed publishing off and one-country scope unchanged. Candidate code 72 has not been submitted. Existing source-bound main Android AAB workflow retains frozen remote signing, package/version/commit checks and certificate SHA-1 75:25:B4:FC:9A:9D:03:4A:E2:94:92:2A:D4:3D:B1:84:43:D0:E1:4D, plus native artifact verification. A feature-branch review workflow performs source/web/Android-JavaScript checks only; it does not establish a signed store binary or authorize bypassing main release policy.

No AAB, production upload, store review result, new web saved/deployed version, phone installation, pending-work upgrade or post-release success is asserted. Final candidate commit/PR and remote pipeline are pending the release owner.
