# Independent prototype verification

**Scope: G1 design fixture only. This is not Android, evidence-integrity, accessibility or release certification.**

The independent reviewer exercised the rendered DOM through clicks, input/change events and keyboard events. Tests read the visible design inspector to verify that simulated original/job identifiers survive navigation and retry. They do not call the prototype's transition API to drive journeys.

The candidate represents synthetic accounts, media, authorizations and server responses. No real camera, video, signature, upload, hash, payment, provider account or evidence record is accessed. Reloading the page resets the fixture; it does not demonstrate durable storage.

Final checked HTML SHA-256: `bf8227135610f54c266b6f20b3bc5a6cabb50f213d10f2382b17e0c84335e724`. Checks were executed during the 15 October 2026 G1 review task; this hash identifies the tested candidate. Later changes require a fresh run.

## Reproduce

Use Node 24.15 or newer (tested with **24.19.0**) and **jsdom 30.1.2**. jsdom also supports Node 22.22.2 or newer within its documented engine range. Install dependencies outside the production mobile tree:

```sh
npm install --prefix /tmp/packproof-prototype-qa jsdom@30.1.2
NODE_PATH=/tmp/packproof-prototype-qa/node_modules node docs/mobile-experience-rebuild-2026-10-15/prototype/verify-prototype.cjs
```

The runner returns nonzero for any failing check and prints each result. Its network stub rejects any attempted `fetch`; no external resource loader is enabled. All controls under review are the actual HTML controls. The runner checks visible labels and simulated state transitions; it cannot measure layout.

## Behavioral checks

The final run passed **60/60 grouped checks**, including a 12-screen × 2-theme × 3-text-scale structural sweep. The sweep uses a 320 px design viewport; separate checks exercise the 320/360/393/411 px review controls. These values are design pixels, not verified Android density-independent pixels.

| Area | What the checks establish in the fixture |
| --- | --- |
| First manual journey | Three deliberate decisions from Home to recording: Create Proof, Continue to camera, Start recording. The recording then proceeds through review, unchecked declaration, secure authorization simulation, transfer, server receipt, and finalization. |
| Consent | Submit is disabled until checked. Item changes invalidate consent and signing. An explicit retake requires repeatable packing and a fresh declaration. |
| Recording interruption | Back warns before stopping. The resulting partial take is labeled incomplete and cannot enter complete-recording submission. |
| Review exit | Leaving review preserves the simulated original and Home resumes review. |
| Upload recovery | Failed/interrupted/queued uploads retain original and job identifiers. Received and finalized remain separate milestones. Unknown acknowledgment checks the same job before any retry. |
| Navigation consistency | Home, Proofs, Capture resume and Updates reach the same failed-upload recovery. Known scan retains the existing job. |
| Multiple work items | Starting a new Proof or selecting an imported order preserves the existing recoverable record and makes it reachable from Proofs. |
| Permissions and eligibility | Camera denial, low storage, unavailable secure signing and allowance denial stop recording, explain the issue and expose an explicit simulated recovery. A new offline capture stops before recording to resolve eligibility. |
| Scanner | Unknown code has manual/existing-record fallback; camera denial has recovery and manual fallback. |
| Buyer waiting | The buyer fixture has no seller attention task, unrelated seller records, seller capture action or sharing action. Waiting is excluded from Needs action. |
| Shipment | Tracking form is collapsed initially; saved tracking has manual provenance and unavailable carrier connection; evidence remains unfinalized. |
| History | Two ordinary events expose named expandable detail controls. The empty-history fixture does not fabricate activity. |
| Catalog | Search/filter selection survives viewer return; waiting is excluded from Needs action; empty Capture does not show empty search/filter controls. |
| Menus and settings | Six profile destinations are discoverable; Escape dismisses; modal keyboard wrapping and invoking-control focus restoration work in DOM. Advanced receipts, privacy/deletion and other capture entries remain reachable. |
| Loading/error | Home, Proofs, Capture, Camera, Review, Evidence, Shipment, History, Updates and Integrations have explicit loading/error recovery. Original/job identity survives these modes. Opening pending uploads without media renders an empty state, not an upload. |
| Empty fixtures / local menus | Applicable external Empty selection deliberately resets synthetic data; its visible action matches the new fixture. Profile/Settings local menus remain available for N/A remote-read states. |
| Offline mutations | Review offers reconnect instead of secure submit. Tracking-save attempts keep entered details and request reconnection. Upload retry queues; unknown acknowledgment cannot advance to server receipt while offline. |
| Provider authorization | Pending, canceled, failed and expired authorization never show connected success without an explicit simulated accepted response. Buyer permissions survive error recovery and offline views. |
| Semantics | Controls have an accessible-name source; at most one active primary button is present on each tested surface; upload stage announcements and a reduced-motion override are present. |

The structural sweep excludes elements marked `inert`, hidden or `aria-hidden`. It verifies at most one active primary button; it does **not** prove visual prominence, color contrast, touch size or viewport fit.

## Design-state coverage audit

| Required screen | States represented in the clickable candidate | Coverage limits |
| --- | --- | --- |
| Home | Fresh, resumable, failed/queued/unknown upload, interrupted recording, finalized, buyer waiting, loading and error | Priority logic is synthetic; all multi-record conflicts and real server/cache reconciliation are not modeled. |
| Proofs | Empty/search empty, status filters, current and preserved records, loading/error, buyer-scoped records | Real pagination, refresh order and account switching require native implementation tests. |
| Capture | No orders, linked order, view-only buyer, capability loading/error/offline, manual/resume/scan/other-stage entries | Complete batch, grading, receiving, return and witness flows are supporting entry previews. |
| Camera | Ready, recording, initialization loading/error, permission/storage/allowance/signing/offline preflight, interruption decision | Preview and timer are simulated. No native permission, microphone, secure signing readiness or storage operation occurs. |
| Review | Saved complete take, opening/loading error, offline review, unchecked/checked declaration, item edit, retake, leave-review decision | No actual video is embedded. Mandatory supplementary-photo recipes and actual signing failure are not exercised. |
| Evidence | Missing recording, saved recording, interrupted partial take, pending task, finalized, buyer view, lookup loading/error/offline | Hash/manifest and server state are fixture claims labeled as such. Authorization enforcement is not validated. |
| Shipment | No tracking, focused form, saved manual tracking, carrier unavailable, view-only buyer, lookup loading/error, offline save guard | No real detection, carrier event, authorization check or asynchronous tracking fetch occurs. |
| History | Empty, two ordinary events, finalized milestones, limited buyer activity, expandable detail, lookup loading/error/offline | Pagination and real authorized audit-stream reads are not exercised. |
| Updates | Fresh empty, failed/queued/unknown upload, interrupted recording, finalized information, buyer event, loading/error/cached offline | Actual notification delivery, permissions and account scoping require native/backend tests. |
| Profile | Light/dark sheet, six routes, close/overlay/Escape, large text control | Real Back, safe areas, focus order under TalkBack and physical touch target reachability remain unverified. |
| Settings | Grouped destinations, appearance, notification and receipt preferences, privacy/deletion route | Account/billing and many supporting flows show context previews, not working production operations. |
| Integrations | Optional disconnected/linked provider, unavailable provider detail, loading/error/offline, pending/canceled/failed/expired authorization, manual path | Provider responses are simulated; real OAuth and live marketplace availability are not tested. |

All 12 surfaces have light/dark and 1.0/1.3/2.0 text controls. Applicable empty/loading/error/offline states are modeled; Profile/Settings local navigation read failures and empty Camera/Review data are explicitly N/A. The applicable external Empty control selects a fresh synthetic account/record fixture, including its actor assumptions; this is not a product operation on a protected original or a runtime permission change. Loading/error/offline inspection preserves source/job metadata and actor permissions. Specialized policy and account scenarios remain separate from this read-state coverage; none may be inferred as passed.

## Findings and fixes

Review identified these candidate defects and requested fixes from the prototype author:

1. A known scan replaced a recoverable upload with a new missing-recording state. The matching Proof now survives the scan.
2. A buyer waiting fixture exposed unrelated seller records and an attention task. Buyer rows are now limited to the permitted current Proof.
3. Starting another Proof discarded the currently selected recovery fixture. It now preserves the earlier record and its simulated original/job identifiers.
4. Modal dismissal restored focus to the profile button instead of the submit button. Same-screen cancellation now restores the invoking control.
5. Selecting an imported order could discard an earlier recoverable record. The same preservation requirement applies to order selection.
6. Denied scanner entry still displayed an available scanner. It now explains camera access and exposes manual fallback.
7. Opening an empty pending-upload route could imply a transfer. It now renders an explicit empty state.
8. Upload stage changes now use a stable polite status region outside the rerendered phone. The existing reduced-motion override is covered by the verification runner.

9. A render-only empty override could show a capture action that resumed a different underlying upload. Empty selection now initializes coherent synthetic fixture data; the first product interaction exits the empty override.
10. The new offline/read-state controls were checked against submission, tracking, retry/reconciliation and buyer permissions. Explicit offline guards prevent new acceptance claims; provider authorization states require explicit simulated acceptance.

All items above are resolved or verified in the final 60/60 run. The test runner is the source of truth when the candidate changes. A passing DOM run does not waive the limits below.

## Nominal theme-token contrast

Ratios below are calculated from the authored solid sRGB token pairs using relative luminance. They exceed 4.5:1 for these specific pairings. This does not validate compositing, opacity, every control, focus indicators, image text or rendered contrast.

| Pair | Light | Dark |
| --- | ---: | ---: |
| Main text / background | 13.67:1 | 15.47:1 |
| Muted text / main surface | 5.97:1 | 7.87:1 |
| Primary button text / fill | 5.57:1 | 5.79:1 |
| Pending text / notice | 5.94:1 | 6.94:1 |
| Failed text / notice | 5.27:1 | 5.70:1 |
| Success text / notice | 4.73:1 | 5.64:1 |

## Explicitly unverified and not passed

- Rendering, clipped text, overflowing chips, first-fold positions, compact sheet geometry, 48 dp touch targets, image quality and actual visual comparison against S01–S09. jsdom has no layout engine.
- Real 320/360/393/411 dp Android devices, 200% system font, keyboard/switch navigation, TalkBack announcements, safe areas and Android Back.
- Real continuous camera recording, playback, native secure signing, supplementary capture policy, device storage, background/force-stop recovery, two-device finalization and source retention.
- Auth/token expiry, account switching, server-side permissions, idempotency, duplicate charges, hashes, rejected attestations, append-only writes and rollback queue compatibility.
- Specialized account authentication expiry, conflicting-label review and policy-required supplementary-photo capture are not demonstrated by the general screen-state matrix. Add those scenarios from verified contracts; do not infer their policies from ordinary packing.
- Five unassisted target-user sessions, installed-build parity, G2/G3 acceptance and G4 release authorization.

**Gate result:** reviewable G1 interaction candidate, with the limits above. Founder approval is still required for this exact design revision before production UI changes. This report neither supplies that approval nor claims the master implementation plan is complete.
