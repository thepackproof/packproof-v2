# Mobile UX recovery — 13 October 2026

Specification: `PackProof_Mobile_UX_Recovery_Plan_for_ASTRA_2026-10-13.docx`. Baseline: `2a015b0bb83988e39a6d559b5ae02c6321bf8f14`. Android target: `com.packproof.mobile`, 1.0.1 (64). The owner authorized production publication excluding iOS and explicitly said **"Publish without device checks"**. No physical-device, novice-study, founder-design-review or performance result is asserted by that authorization.

## Implementation and preserved ownership

- Home, Proofs and Updates share `selectRecoveryWorkspace`. Home has one recommendation, a distinct Create Proof action, at most three additional action rows and no repeated hero. Counts map to the same destination filters. Cached classifications describe saved work and never authorize a command.
- `openProofAction` revalidates the server before routing Home, list, Updates and notification/deep-link actions. Existing `station` and `activity` route IDs remain compatible; their labels are Capture and Updates.
- Proof detail uses Evidence, History and Shipment, compact identity, expandable metadata/originals, grouped access counts and one permission-aware optional-tracking empty state. Continuous video, required attestations, immutable manifests and server finalization remain unchanged.
- Grading creation persists an account/API-scoped idempotent request before sending it. Recovery reopens the same transaction, Proof and assets. It does not create another Proof on a timeout or repeat tap.
- Grading photos move from component-local picker URIs to durable document storage. Scope includes account, API, Proof, action, recipe, asset and transfer. Retakes preserve prior originals. The existing provider owns submission; upload and workflow request keys are persisted before bytes leave the device.
- A committed server receipt with a valid SHA-256 is required before displaying "Uploaded". A lost commit response is reconciled without reupload. A lost workflow response can replay only the original request after every referenced receipt is confirmed. Changed roles/items cannot start new uploads. Finalization is still a separate authoritative action.
- Local drafts remain discoverable and exportable after the server's next step changes. No new automatic file cleanup or retention change was added. Packing video keeps its existing recovery coordinator.
- The station retains scanning, manual fallback, order selection and the station loop. Profile tools, accounts, billing, integrations, sharing, signatures, attachments, notifications and original downloads retain their routes and authorization.

## Verification record

The complete mobile Node suite reports **414 passed, 0 failed, 1 skipped (415 tests)**. Mobile and backend TypeScript checks pass. Targeted backend integration verification reports **76 passed across 7 files**: grading-create-recovery, custody-workflow, transaction-idempotency, mobile-ui-presentation, mobile-recovery, mobile-attestation-authorization and finalize-requirements. The full baseline CI has seven pre-existing failures in research tests; no backend production implementation is changed by this recovery release.

Source-screen browser rendering uses actual React Native screen components with synthetic records, native-service stubs and React Native Web. It is layout/navigation evidence, not an Android runtime or authenticated customer end-to-end test. The S1–S9 comparisons and compact/large-text states are retained with the task deliverables. At 320 CSS pixels, normal-text Home exposes Continue capture and Create Proof without scrolling. At simulated 200% text, header actions move to a separate row, navigation uses two columns and the camera action remains reachable by scrolling. TalkBack and native gesture/keyboard behavior remain untested.

| Plan case | Evidence and remaining limit |
| --- | --- |
| T01 First Proof | Existing intent/manual-operation/task-home tests plus real grading creation API replay. Unassisted native end-to-end journey not performed. |
| T02 Resume entry points | Shared selector and fresh router; source Home action opens guided evidence. Notification/deep-link paths use the same router. Actual push delivery not exercised. |
| T03 Guided photos | Unit coverage for scope, retake retention, ordered receipt/application, missing originals and changed roles/items. Native camera not exercised. |
| T04 Continuous video | Existing capture recovery, limits, completion and handoff tests pass. Physical Android interruption/Back/background not performed. |
| T05 Offline/relaunch | Persist-before-network, stable keys, timeout replay, lost receipt and account change tests pass. Native process death/OS persistence not observed. |
| T06 Counterparty | Existing authorization and optional-counterparty backend tests pass. Two-device session not performed. |
| T07 Finalized integrity | Backend finalization requirements and custody tests pass; photo context refuses new capture on finalized Proofs. Existing manifests unchanged. |
| T08 Station | Existing intake, scan-resolution, order, identifier and station tests pass. Camera/barcode hardware loop not observed. |
| T09 Tracking | Existing tracking/presentation tests and single optional empty state reviewed. No live carrier mutation made. |
| T10 Count agreement | Three Proofs / zero uploads, cached states, waiting buyer, finalized Proof, pending photos and submitted recording cases pass. Submitted recordings use Saved copies, without claiming finalized Proof status. |
| T11 Accessibility | Compact and enlarged-text source rendering reviewed; minimum 48 dp controls preserved. Native TalkBack/insets/split-screen untested. |
| T12 Evidence consumption | Existing Proof record, history, sharing and authorization tests pass. Source views reviewed; original export requires native validation. |
| T13 Permission/storage errors | Permission recovery UI retained; missing file, incomplete receipt and failed persist fail closed in tests. Physical revocation/low disk not exercised. |
| T14 Duplicate prevention | Stable per-slot and workflow keys; provider locks; grading creation API replay/conflict tests pass. |
| T15 Account/onboarding | Existing first-experience, auth, billing and route tests pass. No registration/deletion or novice study performed against production. |

## Observability and performance

Session-only, allow-listed numeric metrics retain no identifiers, content, tokens, tracking values or file paths and are cleared on account change. Photo events distinguish camera launch requested, cancellation, intervention, submission started and acknowledged. The camera API has no ready callback, so launch is not mislabeled camera-ready. `readMobileUxPercentile` returns p95 over the last 100 valid samples or null for an empty sample; tests cover bounds/reset. Existing capture/recovery/finalization metrics remain available.

No representative native startup, list or tap-to-camera baseline, production conversion sample, ten-person usability study or three physical-device recordings was collected. The <=10% p95 regression target and 90%/80% novice targets are therefore **unmeasured**, not passed. Browser timings must not be substituted for those results.

## Release and rollback

1. Keep source revision, CI run, AAB hash, upload certificate and binary configuration verification together. Submission, review and live availability must be recorded separately.
2. Publish Android through the existing signed production pipeline. Do not build or submit iOS under this authorization.
3. New error loops, wrong account access, lost originals, duplicate records or premature completion labels trigger an immediate halt and repair.
4. Roll back presentation by building from this recovery-capable source with `EXPO_PUBLIC_PACKPROOF_MOBILE_TASK_UX=false`, or by selectively reverting presentation components. Keep the new provider/photo journal and creation recovery code, API contracts and video journal readers. Rehearse the flag-off configuration and recovery tests before promoting that rollback.
5. Do not uninstall, clear application data, delete journals, rewrite server evidence or distribute an older binary that cannot expose new photo drafts. Existing server commits and immutable Proofs survive presentation rollback.
6. Device checks were waived by the owner. Signing, configuration, account isolation, evidence integrity and server authority remain mandatory.
