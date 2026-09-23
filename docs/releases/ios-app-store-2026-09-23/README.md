# PackProof iOS App Store execution — September 23, 2026

Status: **Apple distribution certificate and both App Store profiles created; signing-file downloads blocked; no signed IPA, upload, or submission**. This record distinguishes completed Apple account/signing-record work from unsigned simulator validation and pending build distribution.

## Source and identity

- Initial release baseline: `e80365a583139dd19e64241c25afbf5759e46dde` on `codex/android-play-optimization-2026-09-17`. At baseline inspection, GitHub main was `6bbfb397c49346d4b6ff9be47c3889be5d0415eb`; PR #51 contained the two newer release commits.
- Working release branch: `release/ios-app-store-20260923`.
- Apple team and submission configuration was committed and pushed as `b6b351a527dbad23145dd8bcce7351ce08e455eb`.
- Latest remote release checkpoint before this status update: `0be2a59c2adcf4230369de3ab2ae40c0b071d003`, tree `01421598a42de25f846f15f35d1b575d281f000d`.
- Marketing version: `1.0.1`. Candidate build number defaults to `1`; confirm uniqueness in App Store Connect before building.
- Bundle ID: `com.packproof.mobile`; extension: `com.packproof.mobile.OrderShare`.
- App Group: `group.com.packproof.mobile.orders`.
- Verified active Apple Individual team: `AAY67GYL4D`, Collin Neri. App Store Connect app ID: `6815401074`, SKU `packproof-ios-1`.
- App Store listing title: `PackProof: Shipment Evidence`; device display name remains `PackProof`. Apple rejected the exact listing title `PackProof` because it was already in use.
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
| Post-setup team/submission configuration and plugin checks | 23 focused tests passed after the Apple configuration change |
| API /health | HTTP 200, status ok |
| API /meta | HTTP 200; source `272351488a6efcdd1c95a8e3f8ca007d57fe9fbc`, version `2026-09-15-mobile-intake`, environment label `staging` |

The existing shared API endpoint is retained; its `staging` environment label is not a new production deployment. No live user data was created or deleted during these checks.

[GitHub iOS run 35180693558](https://github.com/thepackproof/packproof-v2/actions/runs/35180693558) succeeded: Xcode 26+, native generation, CocoaPods, Swift host/modules/Share Extension compilation, simulator packaging. The signed archive job was **skipped**. The run is associated with head `e80365a`; its artifact uses PR merge SHA `903f30f543eadc1470f579bc70a3d8169571bc46`. A direct git comparison confirms no mobile/backend differences between that merge and the selected baseline. Artifact ID `10480902329` is an unsigned simulator build, not an IPA.

## Live account findings

Expo browser session is authenticated. Its inspected iOS-only build history contains simulator builds, latest successful build `0479b7e0-f685-4adc-8dc5-799b6842ad93` at version `0.3.20 (1)`, source `36c9729`. No store-signed iOS build was listed. Project credentials showed no iOS bundle credentials and prompted to upload Apple credentials. The local EAS CLI has no authenticated session; use the existing authenticated Expo GitHub integration where practical rather than requesting a second sign-in.

Secure Apple authentication succeeded after the owner explicitly authorized Apple sign-in and continuation in chat, and was renewed after the initial session expired. The active Individual membership is Collin Neri, team `AAY67GYL4D`; the account agreements inspected were already accepted. No new legal agreement was accepted in this work.

The host and OrderShare identifiers were registered, and `group.com.packproof.mobile.orders` was registered and assigned to both. Host capabilities are App Groups, Associated Domains, and Push Notifications; the extension has App Groups. Registering capabilities does not demonstrate working provisioning, APNs delivery, or device behavior.

App Store Connect app `6815401074` was created with bundle `com.packproof.mobile` and SKU `packproof-ios-1`. Its saved version is **1.0.1 Prepare for Submission**, with **Manually release this version** selected. The title, subtitle, Business category, description, promotional text, keywords, and support/marketing URLs were saved; see `LISTING.md` for exact copy and remaining fields. Record: https://appstoreconnect.apple.com/apps/6815401074/distribution/info

`mobile/app.config.js` now specifies the verified `ios.appleTeamId`. The `ios-testflight` submission profile in `mobile/eas.json` now specifies `ascAppId` and `appleTeamId`; both changes are in pushed commit `b6b351a527dbad23145dd8bcce7351ce08e455eb`.

After authentication was renewed, the authorized CSR upload completed and Apple created the distribution certificate and both App Store provisioning profiles:

| Signing record | Verified Apple portal identity | Expiration |
| --- | --- | --- |
| Apple Distribution certificate | `V96AUJMGWF`, name Collin Neri | 2027-09-23 |
| Host App Store profile | `PackProof App Store 2026-09-23`, portal ID `4X38P8PF9G`, bundle `com.packproof.mobile` | 2027-09-23 |
| OrderShare App Store profile | `PackProof OrderShare App Store 2026-09-23`, portal ID `4U8MQGUUHF`, bundle `com.packproof.mobile.OrderShare` | 2027-09-23 |

Both profiles use the same distribution certificate. A local public CSR and its private key remain securely outside the repository; no secret values or paths are recorded here. Creating these Apple portal records is not evidence of having downloaded or installed the signing files.

The standard browser certificate-download action failed with `Protocol error (Fetch.failRequest): Invalid InterceptionId`; the following page inspection was blocked by a browser policy/protocol error. The certificate download was not retried through another route. An independent provisioning-profile download hit the same error, after which the browser runtime was reset. No `.cer` or provisioning-profile file was obtained, and no `.p12` was created. The Expo host App Store credentials wizard reached certificate upload at step 4 of 8 but remains unsaved; no credentials were uploaded to Expo. No signed build, IPA, or App Store Connect build upload was created.

## Actual release blockers

1. **Signing-file download handoff.** Apple authentication, authorized CSR upload, certificate creation, and both provisioning-profile records are complete. The browser could not deliver the certificate/profile downloads because of the protocol failure described above. The owner must download the existing certificate and both existing profiles from Apple Developer and provide those files through the supported file handoff; do not create duplicates or try to bypass the failed download boundary. Then match the downloaded certificate to the securely retained private key, package the signing identity as a password-protected `.p12`, and configure both targets' Expo signing credentials securely. Verify/configure the required APNs credentials separately. Do not store passwords, private keys, or signing credentials in source or reuse a simulator archive.
2. **Published policy incomplete.** Live `https://thepackproof.com/privacy` visibly says “Draft for review” and contains legal-entity, privacy-contact and mailing-address placeholders. Public support email `nericollin@thepackproof.com` is verified at `/contact`, but it does not establish the legal entity/address or approved retention obligations. The policy also needs the current Share Extension intake transmission/local expiry and active provider practices reconciled. Source: `web/src/legal/documents.ts`, `docs/INTAKE_IOS_RELEASE.md`.
3. **Account deletion completion unproven.** In-app Account → Privacy & account → Request account deletion exists. `backend/src/domain/account-deletion.ts` inserts the request/audit and returns status. No completion processor, operator completion path or completion-time commitment was found. Apple allows manual processing with a communicated timeframe and completion confirmation; a request queue alone is not evidence of fulfillment. Resolve retention grounds and implement/test the approved complete process before claiming compliance. Do not delete shared immutable evidence or declare an indefinite “integrity” exception without an established retention basis.
4. **Signed-device gates.** Camera/barcode, Secure Enclave Face ID/Touch ID, background/force-close upload recovery, share extension provisioning, push delivery and actual link routing remain untested on an iPhone. Bundle one device checklist after a TestFlight build exists; do not ask the owner to test an unsigned simulator artifact.
5. **Store completion.** Draft listing copy and manual release are saved in App Store Connect, but actual screenshots, signed-build selection, App Privacy answers, age rating, Content Rights, verified copyright ownership, export-compliance review, pricing/availability, reviewer access, applicable Digital Services Act information, and final App Review submission remain pending. Saving metadata is not review submission or approval.

## Prepared and preserved

`LISTING.md` records the source-based metadata saved to App Store Connect, draft reviewer notes, and pending screenshot capture briefs. `PRIVACY-AUDIT.md` records the source-backed data inventory and unresolved declaration facts. App Store Connect setup screenshots document account/listing work; they are not app screenshots for the listing. No generated/mock UI screenshots are represented as actual iOS screenshots. Corrected the obsolete image/PDF/OCR Share Extension claim in `docs/IOS_RELEASE.md`; the current extension accepts text and one URL.

Apple team/submission configuration, draft store metadata, and the certificate/profile portal records changed as recorded above. No production app behavior, backend infrastructure, Android configuration, or public policy was changed in this work. Do not report the signing files as downloaded or the app as built for distribution, uploaded, processed, TestFlight-tested, or submitted.

## Continuation

Obtain the existing certificate and both provisioning-profile files through the signing-file handoff above. Validate their team, bundle identifiers, entitlements, certificate linkage, and expiry; package the retained private key with the matching certificate securely and finish both targets' Expo credential setup. Use the existing `ios-testflight` store build and submission profiles, which contain the verified team/app identifiers; set a unique iOS build number without changing Android. Build from the committed release source, inspect the signed IPA, upload it to App Store Connect, and verify processing. Resolve the above policy, deletion, disclosure, review-access, and real-device gates, attach the selected build and actual screenshots, and submit for App Review. Manual release after approval is already saved; retain it.

Owner input should be limited to the blocked signing-file download handoff, Apple-controlled authentication/legal acceptance that becomes necessary, and genuinely unresolved policy facts. Both sign-in and CSR-upload authorizations persist; do not request them again merely because the session needs renewal. Proposed policy default for review: fulfill account/data deletion, retain only records with a documented applicable retention obligation, and communicate completion timing and confirmation. This is a proposed decision, not an implemented or legally validated policy.

## Primary references checked September 23

- https://developer.apple.com/news/upcoming-requirements/
- https://developer.apple.com/support/offering-account-deletion-in-your-app/
- https://docs.expo.dev/build-reference/app-versions/
- https://docs.expo.dev/submit/ios/
- https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/
