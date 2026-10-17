# October 17 pre-approval corrections

The founder approved the visual direction conditionally for continued implementation and explicitly withheld final release approval. This revision preserves the existing typography, spacing, primary-action hierarchy, document surfaces and completed state. It does not claim the whole master plan or its device/usability gates are complete.

## Requested corrections

| Request | Interactive review | Native Android source |
| --- | --- | --- |
| Recording abandonment and recovery | Back/Home/camera reopening retains the same pending take. Explicit review, keep, retake and confirmed discard. Interrupted sample media is inspectable. Browser reopening restores fixture state. | A camera request cannot implicitly replace a retained original. Explicit retake must match its exact URI; submitted recordings remain locked. Interrupted media can be inspected and kept or deliberately discarded. Interrupted/missing takes cannot enter continuous-recording submission preparation. |
| Automatic photo completion and recovery | Save advances through explicit sample file and item acknowledgments. Held-response, timeout, retry and reopen controls demonstrate incomplete states. Retakes receive unique IDs and retain earlier samples. | Existing upload/commit/item-action protocol now has a shared draft lock, persisted submission intent, actual API acknowledgments, foreground/network recovery, three bounded automatic attempts and an explicit Check action. Lost responses reuse upload identities and the original action key. Local retakes copy to new durable files; submitted originals cannot be replaced. |
| Meaningful motion | Separate task, photo acceptance, record-start/stop and server-confirmation cues. | Native transitions respond to task/receipt/recorder changes without remounting the camera or advancing domain state. Reduced motion stops transitions. Haptics remain suppressed until the recorder promise settles. |
| Evidence naming | Capture / Evidence / Tools in all applicable scenarios. | Same destinations in the internal composition. Evidence keeps originals, Activity, Shipment and Order details. Tools route to existing search, compare, case and history owners. |
| Warmth and returning Home | Warm paper default, neutral comparison, charcoal, text scaling. Returning Home has three incomplete Proofs, separate incoming work and one recommended action. | Warmer review tokens; actual existing Home task ranking and item titles, with incoming invitations separated. Native screens contain no sample fixtures. |

The native composition is enabled only on Android with `EXPO_PUBLIC_PACKPROOF_EXPERIENCE_RESTORATION=true`. The internal review workflow sets it; store profiles do not. Safety corrections are independent of that presentation flag. Existing command, authorization, declaration, manifest and finalization owners remain authoritative.

Photo upload bounds are 120 seconds total / 30 seconds without progress. API calls retain the existing request timeout. A timed-out acknowledgment does not mark completion. Recovery rereads durable storage, checks account/API/Proof/item context, reconciles committed receipts and only completes after the actual item action resolves. Merely selecting photos never authorizes background submission.

## Demonstrating the revised HTML

1. First opening: create the sample, record and stop, then Back to capture. Keep the draft, return Home, reopen its Proof and inspect the same take. Repeat using interruption; inspect the sample and choose keep, retake or confirmed discard.
2. Item photos: take the back photo and Save. Normal demonstration acknowledgments advance automatically. Select Hold item-step response to exercise timeout, close/reopen and Check. Retake a locally accepted photo to inspect the preserved earlier sample and different capture ID.
3. Returning Home: inspect three incomplete Proofs and the separate incoming task. Open each by its exact ID. Compare warmer/neutral paper, dark mode, 200% text and reduced motion.

The HTML uses embedded existing Inter, approved logo, sample video and historical reference. It has no evidence backend. Browser persistence and server events are explicitly demonstrations, not proof of native durable media or actual camera behavior.

Build and run using the commands in README. `npm --prefix mobile run test:experience-restoration` now includes recording, photo recovery, native palette and prototype regressions. No dependencies or lockfile versions were changed.

## Verification actually observed

October 17 logs are `verification/revision-*.txt`; October 16 logs remain historical.

| Check | Result | Limits |
| --- | --- | --- |
| Native targeted regressions | 105 passed | Real photo protocol/retry controller, completion coordinator with native I/O ports, provider navigation callbacks, identity/retake guards and native contrast. Camera/filesystem hardware is not exercised. |
| Prototype lifecycle and CSS contrast | 40 passed | 19 fixture lifecycle tests, 21 actual CSS token contrast checks. |
| Prototype DOM | 19 passed | Eight scenarios, recovery/discard/reopen, automatic/held photo acknowledgments, motion, Home and tools. No layout or video decoding claim. |
| Recovery entry/selection regression | 75 passed | Activity, Home, exact recording selection and incomplete-media presentation; overlaps some scenarios in the 105-test set. |
| Actual recovery component bodies | 3 passed | Focused Activity exposes inspection of the exact retained URI; missing files offer no playback control. Native UI ports are substituted. |
| Mobile TypeScript | 809 files, zero errors | Temporary dependency-resolution paths use existing installed packages. Production tsconfig is unchanged; clean-install CI is the independent check. |
| Browser rendering | Unavailable | Browser runtime failed to start. No new rendered screenshot or visual sign-off. |
| Android hardware | Unavailable | ADB could not start its daemon. No physical force-stop, codec, offline-file, TalkBack or frame-time result. |
| Formative/fresh-user studies | Not run | Both required cohorts remain outstanding. |

The PR workflow builds its exact head SHA after standard mobile gates. The artifact receipt checks package, signer, source SHA, 16 KB alignment and packaged credentials, and records the restoration flag. Inspect the actual run/receipt; configuring a build does not establish build success.

Restarted interrupted takes route through the existing account-scoped Activity recovery destination. That destination now offers inspection directly, without invoking the completed-recording resume command. Unplayable surviving files show an honest playback failure and remain available to the existing export/discard controls. A playable fragment is not classified as continuous evidence.

## Remaining work and compatibility

- WP01-02 source discovery complete; installed-build and live contract reproduction pending.
- WP03-04 direction conditionally approved and requested candidate corrections implemented; exact original Zite reference still unverified.
- WP05-10 Android source slice implemented. Device integration and five formative participants are required before broad migration.
- WP11 needs rendered/native accessibility, large-font, TalkBack, reduced-motion and performance evidence.
- WP12 needs five formative and ten fresh-user participants. WP13 web/iOS propagation waits for validated Android contracts.
- WP14/G4 remains withheld. No merge, production deployment, store submission or version bump.

Photo drafts retain schema 1 with optional retry metadata; old SUBMITTING drafts can recover, while LOCAL_ONLY drafts remain unsubmitted. Server endpoints, original identifiers and idempotency keys are unchanged. Per-draft serialization prevents retaking from racing submission. Recovery does not delete original photos or prior retakes. View state adds an optional journey selection.

Removing the review flag needs no data migration. Older clients ignore optional retry/view fields and retain their manual submission path. This is source compatibility analysis, not an old/new binary rollback rehearsal. Follow [ANDROID-VALIDATION.md](ANDROID-VALIDATION.md); do not clear media or uninstall an evidence-bearing app to install the debug-signed review artifact.
