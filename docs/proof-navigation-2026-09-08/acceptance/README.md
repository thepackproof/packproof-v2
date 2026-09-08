# Proof navigation acceptance evidence — 8 September 2026

This checkpoint records the browser observations and automated results gathered during the navigation release. Browser content used controlled QA fixtures. Screenshots and passing tests do not establish that an Android build was installed or that a deployed version passed the same checks.

## Verified automated results

| Scope | Observed result | Evidence |
|---|---|---|
| Backend final CI | 759 tests passed; 11 skipped; 0 failed | [Final backend CI log](logs/backend-final-ci.log). |
| Backend focused acceptance | 57 tests passed in 8 files | [Backend log](logs/backend-focused.log) |
| Integrated web suite | 198 tests passed in 31 files | [Web log](logs/web-suite.log) |
| Mobile cloud validation | Clean npm ci, typecheck and 25 Proof record tests passed | Remote result observed by the release owner; native runtime coverage remains separate. |
| Local mobile redesign suite | 19 tests passed; 0 failed | [Mobile redesign log](logs/mobile-redesign.log); stale expectations were corrected in tests only. |
| Mobile final CI | 87 tests passed; 0 failures/skips; install and typecheck passed | [CI log](logs/mobile-ci159-sanitized.log). |
| New navigation and sharing tests | 12 tests passed on the unchanged runtime using the actual locked dependencies | [Focused log](logs/mobile-runtime-navigation-sharing-tests.log); these files are now wired into the Mobile CI workflow. |
| Signed Android bundle | Build and signature/source verification passed: 0.3.10 (39) | Final release handoff records the downloadable artifact and SHA-256. |

The backend run covers the navigation collection, canonical Proof contract, live sharing, disclosure compatibility, seller authorization, capture relay/recovery, automatic fulfillment and Etsy intake. It includes full-dataset search and pagination without duplicate rows; stable external identity; early authorized sharing with committed sources only; expiry and revocation; finalization rules; exact seller statement/signature binding; and capture restart recovery.

The final web suite passed after a two-line correction that keeps navigation restoration pending while delayed list data loads. The original full backend CI run had 752 passing tests, 11 skips and seven obsolete mobile presentation assertions; all 46 tests in the three corrected suites now pass ([log](logs/backend-ci-corrections.log)). No backend or native runtime change was required by those assertion updates. The final full CI rerun then passed all 759 executed tests (11 skips).

The web suite passed. Its log retains two React list-key warnings in the capture test fixture. A passing component suite is separate from native camera, biometric, keyboard and physical-device verification.

## Observed browser checks

| Check | Observed outcome | Evidence |
|---|---|---|
| Single list and creation control | Proofs shows one New Proof control; Proofs and Connections are the workspace destinations. | [Proofs, 1280](screenshots/proofs-1280.jpg) |
| Needs attention | Actionable recording work remains visible. Completed records and records waiting on another participant are excluded. | [Needs attention, 390](screenshots/proofs-attention-390.jpg) |
| Narrow layout | No horizontal overflow was observed at 320 and 390 CSS pixels. | [Proofs, 320](screenshots/proofs-320.jpg), [unrecorded Proof, 390](screenshots/proof-unrecorded-390.jpg) |
| Desktop layout | No horizontal overflow was observed at the 1280 setting or the 1920 window setting. The latter reported a 1905 CSS-pixel content/client width. | [Proofs, 1280](screenshots/proofs-1280.jpg), [completed Proof, wide window](screenshots/proof-completed-1920.jpg) |
| Browser Back | Production Website → App restored the original filter, scrollTop 217, selected row top 773.171875 and keyboard focus exactly. | Browser interaction at 390 × 1000. Immediate and 4200 ms list responses also pass the [production-wrapper regression](logs/navigation-history.log). |
| Search | Searching for Camera returned one matching Proof. | Interaction observed. |
| Empty attention list | The attention-specific empty state rendered. | Interaction observed. |
| Failed loading | A loading failure rendered the error state rather than an empty-list success state. | Interaction observed. |
| Loading | Loading Proofs was visible at 320 pixels while the request was pending. | Interaction observed. |
| Unrecorded record | The canonical record shows recording needed, its next action and a discoverable Share control. | [Unrecorded Proof, 390](screenshots/proof-unrecorded-390.jpg) |
| Shared unrecorded record | The recipient sees Recording has not been added yet, without capture or attestation controls. | [Shared unrecorded Proof, 390](screenshots/public-unrecorded-390.jpg) |
| Shared upload in progress | Evidence uploading and Evidence is still uploading were shown at 390 pixels; no uncommitted media appeared. | Interaction observed; no dedicated screenshot is included. |
| Shared completed record | A committed two-second controlled video fixture, the exact seller statement and a receipt link rendered. | [Shared completed Proof, 390](screenshots/public-completed-390.jpg) |
| Homepage overlap | Preserved originals. Deliberate sharing. wraps above the following article in normal flow. Heading bottom 533.765625 and next article grid top 557.765625 establish an exact 24 CSS-pixel gap. | [Homepage section, 390](screenshots/homepage-390.jpg) |
| Attestation review | Review and confirm opened Finalize on the same QA-102 Proof. The unchecked statement kept Finalize disabled; checking enabled it; unchecking disabled it again. No finalization was submitted. | [Attestation review, 390](screenshots/attestation-390.jpg) |
| Saved dark appearance | Connections retains charcoal surfaces, readable text and the reversed transparent brand mark. | [Connections in dark appearance, 390](screenshots/connections-dark-390.jpg) |

The exact seller statement is: “The item shown and attached in this Proof is the item I am shipping”. The short completed-video fixture demonstrates rendering only; it is not a real shipping capture or a native camera validation.

## Screenshot dimensions and provenance

The package preserves the supplied browser-capture files byte for byte. The refreshed homepage capture is cropped to its 390-pixel page pane. The filename identifies the intended review setting, while the following table records the actual image dimensions.

| File | Image pixels | Interpretation |
|---|---:|---|
| homepage-390.jpg | 390 × 960 | Refreshed 390-pixel page-pane capture with the measured heading gap. |
| proofs-attention-390.jpg | 390 × 960 | Narrow attention list. |
| proofs-320.jpg | 320 × 960 | Narrow attention list. |
| proof-unrecorded-390.jpg | 390 × 960 | Participant view before recording. |
| public-unrecorded-390.jpg | 390 × 900 | Recipient view before recording; final refreshed logo. |
| proofs-1280.jpg | 1280 × 960 | Desktop list. |
| proof-completed-1920.jpg | 1928 × 1049 | Wide browser capture; observed content/client width was 1905 CSS pixels. |
| connections-dark-390.jpg | 390 × 960 | Saved dark preference; final refreshed icon. |
| public-completed-390.jpg | 390 × 960 | Recipient view with a controlled committed video. |
| attestation-390.jpg | 390 × 960 | Review screen for QA-102; no finalization submitted. |

[Asset integrity manifest](asset-integrity.json) records file sizes, image dimensions, SHA-256 and Git blob hashes.

## Limits and outstanding acceptance evidence

- The attempted browser 200% zoom keyboard shortcut and Ctrl+wheel had no observable effect. Device pixel ratio remained 1 before and after the attempts. Enlarged browser text/200% zoom is **not passed** by this checkpoint.
- Galaxy S24 Ultra and Galaxy A16 5G hardware were unavailable. Android portrait/landscape, enlarged system text, physical Back behavior, camera recovery, fingerprint confirmation and installed-bundle verification remain physical-device checks.
- No browser observation recorded here establishes a failed-upload recovery screen, full screen-reader operation, every legacy/deep-link navigation sequence. Relevant automated assertions may cover individual boundaries, but they do not substitute for those interaction observations.
- Normal and failed sharing, cached-link/offline behavior and authorization boundaries are covered to the extent asserted by the automated suites. A full physical offline capture-to-share sequence is not claimed.
- Deployment verification, source/build identifiers, signed AAB identity and installation status must be recorded in the release handoff. This acceptance checkpoint does not mark those separate release steps complete.

The release may be described as implemented with the documented verification coverage. This report does not claim that every plan acceptance scenario has passed on both clients.
