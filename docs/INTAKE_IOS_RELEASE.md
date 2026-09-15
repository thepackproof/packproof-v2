# iOS intake release and review notes

## Scope implemented

This work reuses the existing Expo/React Native iOS host, camera/attestation/upload interfaces, native `PackProofOrderShare` Expo module, Share Extension target and config-plugin generation. It does not establish that every pre-existing iOS feature has been compiled or qualified on an iPhone.

The extension accepts bounded plain text and one web URL through Apple's standard Share sheet. It shows the selected PackProof destination account and **Add to PackProof**. After that explicit action it atomically saves an account-bound local envelope. When a valid host-created intake-only session exists, it attempts a foreground authenticated POST to the compiled PackProof API for up to three seconds. No shared website is fetched. No source-app private order queue is read.

The extension reports **Added to your packing queue** only for server-acknowledged `READY`. An accepted unresolved submission directs the person to finish preparing the order in PackProof. Without server acknowledgment it says **Saved on this iPhone. Open PackProof within 7 days to finish adding it.** A save failure is an error. **Done** returns to the source app; the extension never tries to launch the parent, start recording or present OAuth.

Screenshot/PDF/image activation and on-device OCR have been removed from this core extension path. Legacy file-based pending imports remain private and quarantined for deliberate re-share/discard. They are not silently uploaded or deleted.

## Signing and generated configuration

For `com.packproof.mobile`, the host/extension share `group.com.packproof.mobile.orders` and the dedicated Keychain access group `$(AppIdentifierPrefix)com.packproof.mobile.order-share`. The extension bundle ID remains `com.packproof.mobile.OrderShare`, with Swift module `PackProofOrderShareExtension` to avoid shadowing the host Expo pod. Both provisioning profiles must authorize these groups; use the real existing Apple application prefix/team.

The plugin preserves other capabilities, gives the extension `APPLICATION_EXTENSION_API_ONLY = YES`, declares both targets to EAS, and includes matching version/build numbers. Its four source files are `ShareViewController.swift`, `ShareIntakeTransport.swift`, `OrderShareStore.swift` and `OrderShareSessionStore.swift`. `PackProofOrderShareAPIBaseURL` is pinned to the same configured HTTPS API in both Info.plists. Build variants with different bundle IDs receive isolated groups.

Universal Links require the actual Apple application identifier in the served association file and real external-tap validation. A generated entitlement or successful custom-scheme open is not proof of Universal Link verification.

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

Linux validation can generate the Xcode project and check source membership, embedding, credentials declarations, entitlement preservation and repeatability. It cannot compile UIKit/Security/CryptoKit against the Apple SDK, sign an IPA, exercise Keychain/App Group provisioning on a device, or verify physical camera/biometric behavior.

The final deployment context must separately record the candidate's real Xcode/EAS compilation/archive result, signing identity/profile, TestFlight build identifier, and physical iPhone checks for capture/attestation/upload recovery, offline/restart sharing, account switching and real Universal Links. Without those results, iOS source implementation is complete only within its verified limits; iOS deployment and feature parity are not claimed.

References: [Apple extension lifecycle/shared storage guidance](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionScenarios.html), [Apple shared Keychain access](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps), [Expo EAS app extensions](https://docs.expo.dev/build-reference/app-extensions/).
