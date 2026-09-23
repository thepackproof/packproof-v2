# PackProof iOS App Store execution — September 23, 2026

Status: **not submitted**. This record distinguishes verified build preparation from unsigned simulator work and pending Apple distribution.

## Source and identity

- Release baseline: `e80365a583139dd19e64241c25afbf5759e46dde` on `codex/android-play-optimization-2026-09-17`, current GitHub mobile head. GitHub main is `6bbfb397c49346d4b6ff9be47c3889be5d0415eb`; PR #51 contains the two newer release commits.
- Working release branch: `release/ios-app-store-20260923`.
- Marketing version: `1.0.1`. Candidate build number defaults to `1`; confirm uniqueness in App Store Connect before building.
- Bundle ID: `com.packproof.mobile`; extension: `com.packproof.mobile.OrderShare`.
- App Group: `group.com.packproof.mobile.orders`.
- Expo project: `0196c3f7-cb3a-472c-99be-825558f227e8`, account `packproof-llc`, project `packproof`.
- Existing production profile: `ios-testflight`, distribution `store`, Release, EAS image `macos-sequoia-15.6-xcode-26.2`, iPhone only, minimum iOS 15.1.
- Keep `PACKPROOF_IOS_BUILD_NUMBER` for independent iOS increments. Dynamic app.config.js and local version management make blind autoIncrement changes unsafe; global remote version management would also affect Android. The extension inherits the resolved host version/build.
- Newer Sites commits at `76db6d8` change public web copy, not the latest mobile candidate.

## Verified this session

| Check | Result |
| --- | --- |
| Clean source baseline / preserved Android source | PASS |
| Locked mobile/backend dependency installation | PASS |
| Mobile TypeScript | PASS |
| iOS config/plugin and feature tests | 98 passed; initial generated-project test skipped, then passed after prebuild |
| Upload recovery | 19 passed |
| Proof record, tracking, scroll restoration | 25 passed |
| Expo Doctor | 18/18 passed |
| Production-profile iOS native project generation | PASS |
| Generated extension embedding, source membership, repeatability | PASS; all 6 plugin tests passed after prebuild |
| Total unique focused tests | 143 passed after generation |
| API /health | HTTP 200, status ok |
| API /meta | HTTP 200; source `272351488a6efcdd1c95a8e3f8ca007d57fe9fbc`, version `2026-09-15-mobile-intake`, environment label `staging` |

The existing shared API endpoint is retained; its `staging` environment label is not a new production deployment. No live user data was created or deleted during these checks.

[GitHub iOS run 35180693558](https://github.com/thepackproof/packproof-v2/actions/runs/35180693558) succeeded: Xcode 26+, native generation, CocoaPods, Swift host/modules/Share Extension compilation, simulator packaging. The signed archive job was **skipped**. The run is associated with head `e80365a`; its artifact uses PR merge SHA `903f30f543eadc1470f579bc70a3d8169571bc46`. A direct git comparison confirms no mobile/backend differences between that merge and the selected baseline. Artifact ID `10480902329` is an unsigned simulator build, not an IPA.

## Live account findings

Expo browser session is authenticated. Its iOS-only build history contains simulator builds, latest successful build `0479b7e0-f685-4adc-8dc5-799b6842ad93` at version `0.3.20 (1)`, source `36c9729`. No store-signed iOS build is listed. Project credentials shows no iOS bundle credentials and prompts to upload Apple credentials. The local EAS CLI has no authenticated session; use the existing authenticated Expo GitHub integration where practical rather than requesting a second sign-in.

App Store Connect currently presents the Apple sign-in form. A secure browser-auth request was rejected by automatic approval review because the attachment alone was not accepted as explicit trusted-text authorization for Apple Account authentication. No retry or alternate sign-in route was attempted; direct user authorization in chat is required to continue. Team identity, App Store app ID, agreements, processed builds, review state and distribution certificates remain unverified until secure authentication. Do not infer them from the owner’s enrollment approval.

## Actual release blockers

1. **Apple access and signing.** Complete secure Apple sign-in/device verification. Inspect actual Team ID, existing identifiers, agreements and app record. Configure both host and extension distribution profiles plus APNs. Do not invent identifiers, store a password in source or reuse a simulator archive.
2. **Published policy incomplete.** Live `https://thepackproof.com/privacy` visibly says “Draft for review” and contains legal-entity, privacy-contact and mailing-address placeholders. Public support email `nericollin@thepackproof.com` is verified at `/contact`, but it does not establish the legal entity/address or approved retention obligations. The policy also needs the current Share Extension intake transmission/local expiry and active provider practices reconciled. Source: `web/src/legal/documents.ts`, `docs/INTAKE_IOS_RELEASE.md`.
3. **Account deletion completion unproven.** In-app Account → Privacy & account → Request account deletion exists. `backend/src/domain/account-deletion.ts` inserts the request/audit and returns status. No completion processor, operator completion path or completion-time commitment was found. Apple allows manual processing with a communicated timeframe and completion confirmation; a request queue alone is not evidence of fulfillment. Resolve retention grounds and implement/test the approved complete process before claiming compliance. Do not delete shared immutable evidence or declare an indefinite “integrity” exception without an established retention basis.
4. **Signed-device gates.** Camera/barcode, Secure Enclave Face ID/Touch ID, background/force-close upload recovery, share extension provisioning, push delivery and actual link routing remain untested on an iPhone. Bundle one device checklist after a TestFlight build exists; do not ask the owner to test an unsigned simulator artifact.
5. **Store completion.** Actual screenshots, App Privacy answers, age rating, export-compliance review, reviewer account and final App Review submission remain pending. The prepared listing file is draft copy, not an uploaded listing.

## Prepared and preserved

`LISTING.md` contains source-based metadata, reviewer notes and screenshot capture briefs. `PRIVACY-AUDIT.md` records the source-backed data inventory and unresolved declaration facts. No generated/mock UI screenshots are represented as actual iOS screenshots. Corrected the obsolete image/PDF/OCR Share Extension claim in `docs/IOS_RELEASE.md`; the current extension accepts text and one URL.

No production app behavior, backend infrastructure, Android configuration or public policy was changed in this audit. Do not report the app as uploaded, processed, TestFlight-tested or submitted.

## Continuation

After authentication, use existing `ios-testflight` signing and build profile; set a unique iOS build number without changing Android. Add the verified `ascAppId` to the matching submission profile. Build from the committed release source, inspect the signed IPA, submit to App Store Connect, then verify processing. Resolve the above compliance and real-device gates, attach the selected build and actual screenshots, and submit for App Review with manual release after approval.

Owner input should be limited to Apple-controlled authentication/legal acceptance and genuinely unresolved policy facts. Proposed policy default for review: fulfill account/data deletion, retain only records with a documented applicable retention obligation, and communicate completion timing and confirmation. This is a proposed decision, not an implemented or legally validated policy.

## Primary references checked September 23

- https://developer.apple.com/news/upcoming-requirements/
- https://developer.apple.com/support/offering-account-deletion-in-your-app/
- https://docs.expo.dev/build-reference/app-versions/
- https://docs.expo.dev/submit/ios/
- https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/
