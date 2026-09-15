# iOS intake release and review notes

## Scope implemented

This work reuses the existing Expo/React Native iOS host, camera/attestation/upload interfaces, native `PackProofOrderShare` Expo module, Share Extension target and config-plugin generation. The host app, native Swift modules and Share Extension compiled successfully with Xcode 26 or newer for iOS Simulator on the core candidate recorded below. Physical-iPhone feature acceptance has not been run.

The extension accepts bounded plain text and one web URL through Apple's standard Share sheet. It shows the selected PackProof destination account and **Add to PackProof**. After that explicit action it atomically saves an account-bound local envelope. When a valid host-created intake-only session exists, it attempts a foreground authenticated POST to the compiled PackProof API for up to three seconds. No shared website is fetched. No source-app private order queue is read.

The extension reports **Added to your packing queue** only for server-acknowledged `READY`. An accepted unresolved submission directs the person to finish preparing the order in PackProof. Without server acknowledgment it says **Saved on this iPhone. Open PackProof within 7 days to finish adding it.** A save failure is an error. **Done** returns to the source app; the extension never tries to launch the parent, start recording or present OAuth.

Screenshot/PDF/image activation and on-device OCR have been removed from this core extension path. Legacy file-based pending imports remain private and quarantined for deliberate re-share/discard. They are not silently uploaded or deleted.

## Signing and generated configuration

For `com.packproof.mobile`, the host/extension share `group.com.packproof.mobile.orders` and the dedicated Keychain access group `$(AppIdentifierPrefix)com.packproof.mobile.order-share`. The extension bundle ID remains `com.packproof.mobile.OrderShare`, with Swift module `PackProofOrderShareExtension` to avoid shadowing the host Expo pod. Both provisioning profiles must authorize these groups. The actual Apple Team ID/application prefix and Apple signing credentials are unavailable in the current authorized configuration; no identifier, signing identity or provisioning profile has been fabricated.

The plugin preserves other capabilities, gives the extension `APPLICATION_EXTENSION_API_ONLY = YES`, declares both targets to EAS, and includes matching version/build numbers. Its four source files are `ShareViewController.swift`, `ShareIntakeTransport.swift`, `OrderShareStore.swift` and `OrderShareSessionStore.swift`. `PackProofOrderShareAPIBaseURL` is pinned to the same configured HTTPS API in both Info.plists. Build variants with different bundle IDs receive isolated groups.

Universal Links require the actual Apple application identifier in the served `apple-app-site-association` (AASA) file and real external-tap validation. Apple Team ID/application identity is unavailable, so a verified iOS AASA association and end-to-end Universal Link acceptance remain unavailable. The prepared entitlement and association tooling do not establish verification.

## Privacy and store declaration delta

The earlier extension was a local-only import/OCR path. This release adds explicit transmission of the order text/URL to PackProof's own API. App Store privacy answers, privacy policy and review notes must reflect the following actual behavior before distribution:

| Data | Storage / destination | Purpose and retention |
| --- | --- | --- |
| User-shared order text or URL | Protected, backup-excluded App Group until server acceptance, explicit discard or seven-day raw-input expiry; then PackProof API intake | Prepare the user's packing order. May contain order IDs, names or other details the source app supplies. Existing backend raw-content retention controls apply. |
| PackProof actor ID and account label | Local destination metadata and dedicated Keychain session entry | Display and enforce the chosen account; no account switching without deliberate assignment. |
| Intake-only session token | Shared Keychain, `AfterFirstUnlockThisDeviceOnly`, synchronization disabled; transmitted only as authorization to pinned HTTPS API | Create/read restricted intake receipts. Maximum lifetime twelve hours; revoked and cleared at logout where the network permits, with local clearance immediate. |
| Stable random submission ID, payload hash, timestamps, delivery receipt | Protected App Group; server intake idempotency record | Crash recovery and duplicate prevention. On acceptance, local raw payload is removed after a receipt is durable. Unaccepted raw input expires after seven days, retaining an explicit `INPUT_EXPIRED` tombstone. |
| Marketplace credentials / full app refresh tokens | Never present in the Share Extension or shared outbox | Marketplace authorization stays in existing backend/host authentication paths. |

The extension makes no advertising/tracking use of these fields. Order content is user content associated with the user's PackProof account; do not continue describing extension handling as exclusively on-device. Specific names, email addresses, addresses or other personal information may appear in what a person deliberately shares and should be covered by the existing policy and applicable store disclosures. Do not claim the extension collects no data merely because it adds no tracking SDK.

The native required-reason manifests declare `C617.1` for container file metadata. The obsolete provider-file timestamp reason has been removed. Required-reason API declarations and App Store data-collection answers are different disclosures; the former do not replace the latter. Intake adds no camera, microphone, broad file-access, screen-reading or clipboard-monitoring permission. Existing capture permissions remain governed by the host workflow.

## Concise App Review walkthrough

1. Use the authorized review environment/account configured for this candidate. Sign in normally in PackProof so the destination and restricted intake session are established. Review credentials belong in App Store Connect's secure review field, not this repository.
2. In Safari, share an HTTP(S) page using **Share → PackProof**. Alternatively share plain order text from an app that exposes text sharing. The extension shows the current destination and **Add to PackProof**.
3. Tap **Add to PackProof**, inspect its honest server/local acknowledgment, then **Done**. The source app remains the foreground app.
4. Open PackProof normally. The imported item is resolved through the same authorized intake/packing queue. An ordinary public item link may need selection or connection; it must not fabricate an authorized commerce order.
5. Repeat offline or after signing out. The extension must preserve a local save and request a normal host sign-in/assignment later. Switching to a different account must not submit earlier account-bound input to that account.
6. Enter **Record packing** only from the foreground host after deliberately selecting an authorized order. Existing capture, seller attestation, commit, recovery and canonical Proof sharing remain the host flow.

Review can use ordinary text/URL shares to qualify receiver behavior. Availability of Share on each marketplace's private order screen requires a separate observation using the actual seller app and version; it is not implied by a synthetic share or Safari success.

## Evidence and remaining release gates

The core implementation at commit `272351488a6efcdd1c95a8e3f8ca007d57fe9fbc` passed [GitHub Actions iOS run 34936353806](https://github.com/thepackproof/packproof-v2/actions/runs/34936353806), completed September 15, 2026 at 06:38:27 UTC. Its macOS job `104274997544` selected Xcode 26 or newer and successfully completed dependency installation, mobile typecheck, iOS tests, existing Proof-record/recovery checks, native project generation, CocoaPods resolution, actual Release iOS Simulator compilation of the host app/Swift modules/Share Extension, simulator packaging and artifact upload. The build used `CODE_SIGNING_ALLOWED=NO`.

| Verified artifact | Recorded value |
| --- | --- |
| Artifact ID | `10384037419` |
| Name | `packproof-ios-simulator-272351488a6efcdd1c95a8e3f8ca007d57fe9fbc` |
| Uploaded artifact size | 16,040,115 bytes |
| Created | September 15, 2026, 06:38:15 UTC |
| Contents | Packaged simulator application and Xcode build log |
| Distribution status | Unsigned simulator artifact; not an installable physical-iPhone IPA or TestFlight build |

Local generated-project checks also verified source membership, extension embedding, matching App Group/Keychain/API configuration and repeatability. The successful macOS run supplies the actual compiler evidence that Linux validation alone could not provide.

Remaining release gates are explicit:

- **Apple signing unavailable:** Apple Team ID/application identity and signing credentials are absent from the available authorized configuration. The signed-archive job was skipped in this push-triggered run; no signed IPA was produced.
- **TestFlight unavailable:** No TestFlight submission or build identifier exists for this candidate in the completed work. Simulator artifact publication is not store distribution.
- **Device acceptance not run:** Physical-iPhone sharing, account switching, Keychain/App Group provisioning, offline/restart recovery, camera capture, biometric attestation and upload/commit recovery still require acceptance on a signed device build.
- **iOS AASA/Universal Links unverified:** The actual Apple application identifier is unavailable; no production iOS association or real external-tap result is claimed.

The core iOS code is compiled successfully for the simulator. Signed iPhone distribution, TestFlight delivery and physical-device feature parity are not claimed.

References: [Apple extension lifecycle/shared storage guidance](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionScenarios.html), [Apple shared Keychain access](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps), [Expo EAS app extensions](https://docs.expo.dev/build-reference/app-extensions/).
