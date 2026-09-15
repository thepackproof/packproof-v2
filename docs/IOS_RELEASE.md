# PackProof iOS release

## Source and scope

The iOS app shares the Android build 49 (`0.3.20`, source `8e3f2959a4c6288d357e716de28d230c92ac9cd8`) React Native app and canonical API. The latest public account-deletion route is retained. App identity is `com.packproof.mobile`; first iOS build number is `1`. Set `PACKPROOF_IOS_BUILD_NUMBER` to a higher positive integer for subsequent App Store uploads without changing the Android version code.

The implementation is a native iOS port, with Swift modules for camera capture, biometric signatures, Share Sheet intake, Apple storefront eligibility and local PDF review. It is not a WebView wrapper. No separate Proof database, lifecycle, or evidence standard is introduced.

## Feature mapping

| Feature | iOS implementation |
| --- | --- |
| Account creation/sign-in/reset/profile/deletion request | Shared Cognito and API flows; existing account-deletion status and public route |
| Proofs, orders, invitations, activity, review and finalization | Shared screens and server-owned state |
| Continuous packing video and barcode feedback | Silent H.264 MP4 through AVFoundation/AVAssetWriter with live metadata detection |
| Shipping and item identifiers | Apple runtime-supported symbologies, Vision recorded-video inspection, explicit IOS policy and provenance |
| Still evidence in grading/custody workflows | Existing shared camera/photo and evidence APIs |
| Deliberate shipping attestation | Face ID/Touch ID authorizes a Secure Enclave P-256 signature; no biometric data crosses the bridge |
| Saved recordings, retry, resume, discard and cleanup | Protected local originals and journals; shared identity-preserving recovery |
| Upload handoff | OS background transfer with the same upload identity; server commit/finalization resumes when app execution is available |
| Shippo/carrier tracking, map, timeline | Same server observations and embedded map components |
| eBay/Etsy/Shopify/Google/Facebook connections | Existing provider flows with verified native callback routing |
| Share to PackProof | App Group Share Extension for text, links, images and PDFs; on-device text extraction and review |
| Proof export, receipt/return records, share links | Same canonical proof/export services and native share sheet |
| Push notifications and preferences | Expo/APNs delivery; account-scoped local fallback for upload completion |
| Themes, fonts, calendar, animations and navigation | Shared Android 49 components, with iOS platform gates corrected |
| Plan, usage, invoices and checkout | Native account panel; external purchase/cancellation actions require the actual Apple storefront to be USA |
| Developer workspaces and API keys | Account → Developer access: sandbox creation, workspace selection, scoped key issue/list/rotate/revoke and API documentation; one-time tokens remain in memory and clear on leave, background or account/workspace changes |
| Desktop-to-phone order handoff | iOS can approve/pair devices, choose a default, send exact prepared orders, receive, claim and record; sender operations keep the same idempotency key across uncertain responses |
| Responses and corrections | Proof → More actions: immutable supplementary statements with durable account/API/Proof-scoped drafts, stable retries and canonical receipt verification |
| Retention and preservation | Proof → More actions: current blockers, participant holds, own-hold release and deletion review requests; server preservation requirements remain authoritative |
| Private media copies | Seller tools for authenticated originals, full-frame normalized masks, server rendering, rendered-copy review and exact-hash approval; originals remain unchanged |
| Item history and recipient export packets | Evidence and claim tools: consent, history linking/events/scoped sharing, explicit case fields/sources and recipient-specific PDF/image exports; verified PDFs open in native QuickLook before approval |
| Remote packing station | Account → Remote packing station: paired controller/camera, order selection, Start/Finish/Next, durable command/acknowledgement retry and barcode command input; camera arming, review and biometric confirmation stay on the camera phone |

Individual barcode formats depend on the Apple runtime; unavailable formats are not claimed. Codabar live detection needs iOS 15.4+. The browser companion remains a browser feature, and public token-based Proof viewing retains the canonical browser access policy. Both packproof-v2 and packproof URL schemes are registered for OAuth and notification navigation. External checkout is hidden for unknown/non-US Apple storefronts; this release does not add StoreKit purchases for those storefronts.

## Build and signing

All iOS EAS profiles use the same authenticated API and feature flags as Android 49. They use Xcode 26.2, require Cognito and HTTPS, and reject camera-spike/development-auth release builds. The deployment target is iOS 15.1.

From `mobile/`:

```sh
npm ci
npm run typecheck
npm run test:ios
npm run build:ios:simulator
npm run build:ios:device
npm run build:ios:testflight
```

The simulator build needs no Apple signing. It cannot validate Secure Enclave or real camera capture. `ios-device` uses registered-device internal distribution; `ios-testflight` creates an App Store archive. Submission is a separate `npm run submit:ios:testflight` step. Do not submit a simulator archive as an IPA.

The Share Extension config plugin registers the app group and EAS extension declaration. Apple signing must cover both:

- App: `com.packproof.mobile`
- Extension: `com.packproof.mobile.OrderShare`
- App Group: `group.com.packproof.mobile.orders`
- Push notification entitlement and a valid APNs key through Expo

An active Apple Developer team and App Store Connect application are needed for TestFlight distribution. Neither Apple signing credentials nor a signed-in App Store Connect session were available when this port was implemented. Expo's existing authenticated GitHub build integration can run `ios-simulator` from the `/mobile` base directory.

The `.github/workflows/ios.yml` workflow compiles the app, all native modules and the Share Extension on macOS with Xcode 26+. Its optional signed build uses existing remote credentials and an `EXPO_TOKEN` secret. It does not submit to the App Store automatically.

The extension uses a distinct Swift module name, includes its own file-access privacy manifest, and takes its marketing version and build number from the resolved app configuration. Its version must remain identical to the containing app when incrementing a release.

## Backend rollout

Deploy the additive API support and migration `066_ios_capture_surfaces.sql` before testing iOS capture. It permits explicitly bound IOS identifier policies without rewriting historical policies. Where item enrichment is enabled, add `IOS` to the existing `IDENTIFIER_SURFACES` rollout. Keep prior surfaces, provider credentials, runtime flags and canonical evidence state intact. See [identifier deployment notes](identifiers-server.md).

The API used by the Android and iOS release profiles completed its staging rollout on 2026-09-14 at 11:37:40 UTC. Migration 066 was applied and checksum-verified, with 67 migrations current. Task definition `packproof-v2-staging-cluster-packproof-v2-staging-api:28` serves source `19fa9af8a8f07e2cd8d0d64152f3bfb62cd98797`, image `sha256:53d98a2c90519f8c16c59291e55abe8e1e20691341d9d9f7132f1be631486d86`. Its backend tree is `94ca7d14c5ffe381c1ec73db35a74c8ec6f1cdd9`, unchanged by subsequent mobile and web corrections. Health, readiness, exact release identity, Android/iOS attestation capabilities, authentication rejection and existing web CORS checks passed. ECS reached steady state with no rollback alarms. Existing integrations, runtime settings and disabled identifier rollout flags were preserved; startup migrations remain disabled.

The follow-up upload-clock correction reached steady state at 11:56:45 UTC on the same day: task definition `:29`, source `ee6ac3414e9e5cd572ccaba64ef510dfa399e94a`, image `sha256:91bd7b9fd6adcc641cf46075c92889912989e4154f7fd7ccf4642e4f781900b5`. It makes multipart completion use the same injected clock as reservation creation and ingress; the boundary regression confirms acceptance immediately before expiry and rejection exactly at expiry. No migration or runtime setting changed. The same live release, health, readiness, capability, CORS and authentication checks passed with no rollback alarms. The deployed production backend source tree is `4fa0d83120a03e518f1d23fa1b8b5c2718a3242f`.

## Verification and physical-device acceptance

Automated TypeScript, policy, lifecycle, OAuth, attestation, upload recovery, billing and plugin tests validate contracts. Clean Expo prebuild and Apple autolinking validate native project generation. These do not substitute for an Xcode compile or hardware tests.

Before calling the app release-ready, record the exact build/commit and test on a physical iPhone:

1. Sign up/sign in, password recovery, sign out and account switching.
2. Record a packing video while scanning real shipping labels; verify feedback, playback, thumbnails and correct tracking association.
3. Test Face ID and Touch ID, cancellation, enrollment changes, lockout and a fresh challenge after key replacement.
4. Interrupt a recording; background/lock during upload; lose network; force-close/reopen; resume/discard without losing the original or duplicating evidence.
5. Import each supported Share Sheet content type, cancel, reopen, sign out and verify account-bound review.
6. Exercise actual provider authorization returns and order synchronization.
7. Confirm APNs permission/denial, muted settings, upload completion, Proof updates and notification routing.
8. Export/share an evidence packet, view receipt/return stages and check the embedded tracking map.
9. Verify billing in a sandbox account with a known Apple storefront and no charges authorized by the tester accidentally.
10. Pair and approve another device, send a prepared order, accept it on iPhone and recover an interrupted handoff without duplicating it.
11. Create a sandbox developer workspace and read-only API key, verify a request, rotate/revoke the key, and verify that leaving, backgrounding or changing accounts hides the one-time secret.
12. Add a correction/recipient response, lose the response connection and resume the same intent; place/release your own preservation hold and submit a deletion review request without removing evidence.
13. Draw and numerically edit masks on portrait/landscape image and video sources, render, inspect the actual copy and approve its exact hash. Review every recipient PDF/image packet before approving, including QuickLook dismissal/background interruption and account changes.
14. Pair remote controller/camera roles, scan an order and Start/Finish commands, interrupt/restart each role, complete local review/biometrics, and verify Next stays blocked until the original capture is committed.

iOS may suspend JavaScript while a background upload is running. Upload bytes can continue through the OS, but commit/finalization may wait until the app runs again. Force-quitting does not guarantee upload completion. Interrupted, unfinished MP4s are preserved where possible but are never represented as valid committed evidence or as repaired media.

## Primary platform references

- [Apple SDK upload requirements](https://developer.apple.com/news/upcoming-requirements/)
- [Expo build infrastructure](https://docs.expo.dev/build-reference/infrastructure/)
- [Apple App Review purchase rules](https://developer.apple.com/app-store/review/guidelines/)
- Native implementation details and test gates: module READMEs under `mobile/modules/`.
