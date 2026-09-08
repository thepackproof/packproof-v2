# Candidate build, physical acceptance and controlled rollout

This recipe does not authorize or claim a deployment. The user authorized implementation; execute only the intended candidate work, retain its evidence, and keep the plan's physical/usability release gates explicit. Do not reuse historical evidence as if it came from this redesign.

## Build identities and evidence

Before the intended signed build, commit and record the exact candidate SHA/tree, branch, dependency lockfiles, app config, native module versions, target API, capture/shipping feature flags, Cognito mode, package, signing lineage and monotonically increasing versionCode. Populate `release-evidence.template.json` with inspected facts; null means not established. No secret values belong in this file.

Record API `/meta`, `/capabilities`, the actual additive migrations/checksums and served web identity. Migration `052_redesign_integrity.sql` adds preserved source observations, label context/resolutions and deletion-request state. Do not claim it is applied from source presence. Preserve predecessor client compatibility, existing origins, eBay/Etsy/shipping configuration, signing and immutable originals.

The previously available AAB `packproof-0.3.8-37.aab` and baseline CI are historical only. A redesigned candidate requires a distinct final-source artifact and checksum. A debug APK cannot be renamed or presented as the signed `.aab` deliverable.

## Existing token-free native compilation path

A new workflow is unnecessary. `.github/workflows/ci.yml` already runs on any pull request and on main pushes. Its **Android attestation Kotlin** job requires no `EXPO_TOKEN`:

1. Node 22, Java 17, Android SDK/build-tools 36 and NDK `26.1.10909125`.
2. `npm ci` in mobile, then `npx expo prebuild --platform android --no-install`.
3. Refuse changed tracked/staged build inputs after prebuild.
4. In `mobile/android`, run `./gradlew :packproof-attestation:compileReleaseKotlin :packproof-unified-camera:compileReleaseKotlin --no-daemon --console=plain`.
5. Build `:app:assembleDebug`, collect APK metadata and a release BOM for the exact CI SHA, and upload `android-debug-release-evidence-${sha}`.

Open/update the intended PR to obtain this job on the redesign's final SHA. Baseline run [34162066457](https://github.com/thepackproof/packproof-v2/actions/runs/34162066457) proved the earlier source compiled; it does not validate the new encoded-frame reader or changed native capture code. A generated debug keystore is not the release signing lineage; a debug build may require Metro and is not proof of upgrade-over-existing-install behavior.

Current Mobile CI already runs typecheck, build-security/release-identity, Proof/tracking/scroll, study-timing, recovery and API/connection scripts. Add persistent coverage for the new tests, using the existing installed tsx loader. From mobile, the supported focused command is:

```bash
node --import ../backend/node_modules/tsx/dist/loader.mjs --test tests/capture-label-review.test.ts tests/sales-channels.test.ts
```

Include the final order-routing model tests if the coordinating owner adds them. Record them in package scripts/CI, not only a local command transcript. Backend and web `npm test` discover the new Vitest cases. Real PostgreSQL release invariants remain a separate required hosted job; local skipped database cases do not satisfy it.

## Existing signed AAB and deployment constraints

| Path | Current trigger/requirements | Evidence produced or remaining |
|---|---|---|
| Android AAB workflow | Push to `main` or `codex/proof-record-parity` touching mobile/workflow paths; or `workflow_dispatch`. Repository `EXPO_TOKEN`; remote EAS signing; `shipping-integration` profile. | Signed AAB Actions artifact after EAS finishes. It does not submit to Play or install phones. |
| Native CI job | PR or main push; no Expo token. | Module compilation, explicitly debug APK, metadata/BOM. No release signing/device result. |
| Deploy staging parity | Manual dispatch only; hard requires main plus successful **same-SHA push CI**; AWS OIDC role or configured repository AWS credentials; Windows PowerShell. | Candidate API + legacy S3/CloudFront web only after complete runtime-preservation/deployment/parity checks. It is not the active Sites web release workflow. |
| AWS CodeBuild | Existing `packproof-v2-staging-api`; S3 backend source; privileged standard:7.0 Docker build. | ECR image build. Build success is separate from applying migrations and updating ECS. |
| Active web hosting | Root-owned existing Site workflow. | Save/deploy/inspect actual Site source and served artifact separately from legacy CloudFront metadata. |

The last inspected signed AAB workflow [34053161448](https://github.com/thepackproof/packproof-v2/actions/runs/34053161448) failed at its Expo-token check, before installing/building/uploading. The present shell has no authenticated GitHub/EAS CLI credentials or Android device tools. Remote EAS metadata could not be read anonymously. These are observed access constraints, not permission to bypass the token gate or retrieve secrets through unsupported connector endpoints.

Connected GitHub source writes are supported through blobs/trees/commits/refs/PRs. No workflow-dispatch tool was exposed during this inspection. A supported authenticated manual dispatch or an intentionally reviewed candidate trigger is needed for a branch build; changing triggers does not supply missing EAS authentication. Stop repeating the same failed build action until its cause changes.

After successful checks and signed build access:

1. Run one intended AAB build from the exact committed source/profile; retain EAS ID, source SHA, artifact checksum/size/version and signing information.
2. Validate the bundle and packaged API/auth/feature configuration using the supported Android tooling. Confirm no camera-spike/developer-only path or wrong environment has been packaged.
3. Upload through the intended internal-testing path, then separately verify processing, track assignment, tester availability and installation on each phone.
4. Record each phone's installed package/versionCode and release artifact/signing association. Run the tests below against compatible API/schema/web source.
5. Generate final BOM with the existing `scripts/release-bom.mjs`; supply exact artifacts/runtime evidence and the expected source SHA. Do not use `--allow-dirty` as release parity evidence.

## Two-phone physical gate

Use the exact candidate on a Samsung Galaxy S24 Ultra and Galaxy A16 5G. Capture date, OS/app versions, artifact/EAS/source identity, API/meta/schema, operator, scenario and evidence reference for each result.

| Group | Required actual exercise |
|---|---|
| Normal journey | Sign in; choose eligible real controlled order; preview; one uninterrupted packing/sealing video; label detection during recording; inspect encoded original; review exact statement; strong-biometric submission; authoritative finalization; open tracking/share. |
| Labels | Missing label; glare; multiple/product codes; wrong-package label; explicit resolution remains attributable; encoded-frame/preview provenance and approximate timestamps remain honest. |
| Recovery | Airplane mode/slow upload; lost commit/finalization response; force-stop at each persistence boundary; reopen original; no duplicate IDs, wrong order or false saved state. |
| Biometric | Cancel, lockout, no enrollment and key invalidation; recording retained; no weak fallback or stored samples. |
| Batch | Three distinct orders, including one delayed upload and one mismatch; same capture/review; next recording never auto-starts; pending work remains discoverable. |
| Upgrade | Install over the previous signed app with old ordinary, legacy-station and stage journals, existing channels and saved Proofs. Verify no lost pending original or changed ownership. |
| Navigation/accessibility | Gesture and three-button Back, long scroll/return restoration, video position, keyboard, TalkBack, 200% font size, light/dark/system and narrow width. |
| Record parity | Same saved/pending/root/stage/source/chronology facts in app, workspace and shared viewer, with permission-specific restrictions. |

No native compilation result closes these rows. Keep a failed/interrupted but retained recording distinguishable from a playable complete take. Never manufacture carrier movement, confirm marketplace fulfillment, or substitute screenshots from a different build.

## Eight-person unassisted usability gate

Recruit at least eight people unfamiliar with PackProof, including several with limited shipping-software comfort. Use at least four participants per phone. Use a real item, box, label and controlled orders. Give only: “You’re shipping this item. Use PackProof to make a record of packing it.” Do not explain the data model or show the previous flow.

Counterbalance connected-order and unconnected-seller first tasks across both phone groups. Each participant can then try the other scenario, but record first-task performance separately so learned second attempts do not inflate first-use success. Inject a recoverable interruption and ask the participant to find the recording/Proof, show tracking and share it. Ask what is saved/locked and whether integrity proves the item authentic.

| Measure | Plan threshold |
|---|---|
| Primary completion | At least 7/8 without coaching; zero lost recordings, wrong-order attachments or false success. |
| Comprehension | At least 7/8 correctly explain saved/locked state and that integrity does not establish product authenticity. |
| Interaction overhead | Median app-only time ≤60 seconds; 90th percentile ≤120 seconds. Measure/report packing time and network wait separately. |
| Extra capture | Zero required separate label photos, pre-scans or end rescans during the normal task. |
| Ease | Median ≥6/7; no recurring severe “I do not know what to do” failure remains. |
| Recovery | Every participant exposed to the recoverable problem can identify where the recording is and what happens next. |

Every facilitator suggestion about what to press counts as assistance and a failed unassisted attempt. Record wrong turns, hesitation, repeated taps, abandonment, requests for help and exact language. Predeclare the percentile calculation and retain all raw durations; with eight people the tail metric is especially sensitive to a single slow attempt. Use fresh participants after substantial changes. A recurring critical failure blocks release even when aggregate thresholds pass.

With consent, retain screen/session evidence separately; keep shipping data and biometric/credential content out of general analytics. Use pseudonymous session/build IDs, event names and durations. This is a small-sample release gate, not a statistically representative market study.

## Rollout, pause and rollback

Release to internal testers before broader distribution. Compare completion, capture failures, pending-upload age, duplicates/false retry reports, crashes and comprehension with the preceding test. Pause on false saved state, evidence loss, mutation, wrong-order association or repeated inability to finish. Distinguish provider/network degradation from UI defects.

Preserve a reviewed known-good source/configuration recipe and signed-artifact identity; the source of the old AAB must be established before calling it a verified fallback. Do not remove new tables, rewrite immutable evidence or delete pending journals as rollback. Keep additive server compatibility with the previous client. Android update-path rollback ordinarily needs a compatible recovery build with a greater versionCode; verify the actual distribution platform procedure before executing it.

Report these states separately: source implemented; tests passed; native compilation passed; signed AAB produced; uploaded; available to testers; installed; physical checks passed; usability gate passed; production deployed. The initial value for each redesign artifact/distribution/device/human state remains **not established** until its own evidence exists.
