# Acceptance evidence and execution record

This packet distinguishes source implementation and local automated/build evidence from real operations, visual comparisons, physical-device and release acceptance. The latter gates remain open. Design-owner structural/visual observations are in design-contract.md and figma-design-ledger.json; they are not installed-app acceptance.

## Evidence record rules

Use Passed / Failed / Not executed / Not applicable. Each executed result needs exact candidate SHA, command or scenario, environment/backend identity, actual browser/device/OS, date, evidence location and known discrepancy. Not applicable requires a real scope/capability reason. Access unavailable means Not executed. Do not reuse old results without documented commit/configuration/platform relevance.

Do not store real private evidence media, signed URLs, credentials, addresses or item/order details in public documentation. Retain an authorized private evidence location and a nonsensitive reference here.

## Risk-focused scenario matrix

| ID | Required scenario and observable result | Status | Evidence |
| --- | --- | --- | --- |
| T01 | Real creation/capture/review/declaration/upload/receipt/fresh record | Not executed | Pending candidate-specific result |
| T02 | Missing or stale consent, partial upload, unknown finalize outcome and receipt modes | Not executed | Pending candidate-specific result |
| T03 | Controlled Back/Stop, background/lock/native failure/force termination | Not executed | Pending candidate-specific result |
| T04 | Restart after local save, accepted and failed retake, cleanup race | Not executed | Pending candidate-specific result |
| T05 | Offline policy/reconnect/auth expiry/unknown outcome | Not executed | Pending candidate-specific result |
| T06 | Concurrent Proofs, rapid switching, late callbacks, duplicate actions | Not executed | Pending candidate-specific result |
| T07 | Account/workspace/access boundaries, cold/warm links and notifications | Not executed | Pending candidate-specific result |
| T08 | Sequential photo tasks, original media orientation/expiry, share/copy | Not executed | Pending candidate-specific result |
| T09 | Chronology/source gaps/late events/neutral integrity language/immutable core | Not executed | Pending candidate-specific result |
| T10 | All inherited and production states, utility reachability and visible controls | Not executed | Pending candidate-specific result |
| T11 | Keyboard/screen reader/200% text/narrow layout/themes/motion modes | Not executed | Pending candidate-specific result |
| T12 | Measured startup/camera/scroll/memory/long media/low storage | Not executed | Pending candidate-specific result |
| T13 | Pending-work upgrade/interrupted migration/activation/rollback | Not executed | Pending candidate-specific result |
| T14 | Station and platform-specific native behavior and exact release artifacts | Not executed | Pending candidate-specific result |

T01 requires an actual creation/capture/review/declaration/transfer/canonical-confirmation journey and freshly fetched record with matching Proof/evidence/receipt identities. A fixture or preview cannot close it. T02 must demonstrate no false receipt when bytes are complete but commit/finalize remains unresolved. T03/T04 require actual surviving files and truthful continuity/eligibility on physical devices. T06/T07 require exact identity across two concurrent records and account/workspace changes. T13 must exercise production-to-candidate upgrade without clearing storage or changing signing identity.

The actual October 20 SIGNAL plan section 13 (pages 18-20) was read on October 24. All AT01-AT28 obligations are now cross-walked in coverage.json, including pass criteria and required evidence; each remains Not executed for this candidate. Its release rule requires every applicable row to pass, with required unavailable hardware still blocking the affected platform. The mapping is traceability, not execution evidence.

## Inherited SIGNAL acceptance cross-walk

| Prior ID | Scenario | Current families | Candidate result |
| --- | --- | --- | --- |
| AT01 | Complete real journey | T01 | Not executed |
| AT02 | Missing declaration | T02 | Not executed |
| AT03 | Controlled leave | T03 | Not executed |
| AT04 | Active interruption | T03 | Not executed |
| AT05 | Stop after local save | T04 | Not executed |
| AT06 | Explicit retake | T04 | Not executed |
| AT07 | Offline entry and capture | T05 | Not executed |
| AT08 | Lost upload connection | T02, T05 | Not executed |
| AT09 | Lost finalize response | T02 | Not executed |
| AT10 | Duplicate or stale events | T06 | Not executed |
| AT11 | Two pending Proofs | T06 | Not executed |
| AT12 | Authorization expiry | T02, T05 | Not executed |
| AT13 | Account switch | T07 | Not executed |
| AT14 | Links and notifications | T07 | Not executed |
| AT15 | Rapid record switching | T06, T07 | Not executed |
| AT16 | Original playback | T08 | Not executed |
| AT17 | Share and copy | T08 | Not executed |
| AT18 | Fresh saved fetch | T01, T02 | Not executed |
| AT19 | Clean install | T10 | Not executed |
| AT20 | Device constraints | T03, T12 | Not executed |
| AT21 | Upgrade local work | T13 | Not executed |
| AT22 | Rollback | T13 | Not executed |
| AT23 | Accessibility and layout | T11 | Not executed |
| AT24 | Restart between stages | T02, T03, T05 | Not executed |
| AT25 | Receipt capability modes | T02 | Not executed |
| AT26 | Replacement commit race | T04, T06 | Not executed |
| AT27 | Full visual coverage | T10 | Not executed |
| AT28 | Every visible control | T10 | Not executed |

## Visual and control audit

- Compare matching Figma and installed screenshots at equivalent logical dimensions: phone 360/390/412, tablet 768/834, desktop 1280/1440/1920; web reflow at 320 CSS px.
- Compare actual font weights, hierarchy, spacing, control anatomy, original-media treatment, safe areas, themes, keyboard-open state and timing. Record intentional system-chrome differences separately.
- Test runtime 200% text. The design's 150% fixture is not this pass.
- Audit every link, chevron, card, filter, tab, menu, avatar and media control. It must work, state its prerequisite or be noninteractive. Retained source routes alone do not establish reachability.
- Verify System/Reduced/Off during active work without recorder remount, paused operation loss or hidden actions.
- Keyboard and screen-reader checks must cover task completion, focus restoration, dialogs, semantic states and meaningful status announcements. Do not announce every timer tick.

Limited browser component-gallery review was executed at measured 390x844 and 1280x720, including light/dark, source selection, Motion Off and overflow checks; see evidence/browser-and-release-review.json. Full 27-state fidelity/control audit, 320px reflow, runtime 200% text, full keyboard/screen-reader tasks and native installed comparison remain Not executed.

## Focused commands and mandatory gates

Inspect the current scripts before invocation. Relevant source-declared entry points include web typecheck/build/test and mobile typecheck, proof-record, recovery, ux-recovery, experience-restoration, first-proof, android-task-first, build-security, font/release-identity/provenance checks. Desktop has typecheck/test/release/artifact checks. Choose changed-risk scenarios and reuse valid evidence; mandatory CI/release/security gates remain in force. This list is not a claim that commands ran or that a broad repeated suite is required for each cosmetic edit.

| Verification | Candidate SHA | Result | Evidence |
| --- | --- | --- | --- |
| Documentation JSON structure and referenced source-path check | Workspace snapshot; not a release commit | Passed: 27 unique inherited states, 21 production states, 14 acceptance families, source paths present, exact design/ledger copies; all runtime gates remain Not executed | Node packet validation, October 24, 2026 |
| Web build/typecheck | Uncommitted candidate over b08daf7982bedb6916702b5e4ee237a314f726da | Passed with cached installed dependencies; not clean-lockfile install/audit | evidence/web-typecheck.txt; evidence/web-build.txt |
| Web Home focused checks | Uncommitted candidate | 13 passed after existing loading copy restored | evidence/web-home-tests.txt |
| Initial combined web focused attempt | Earlier uncommitted candidate | 1 failed, 27 passed; Home failure subsequently corrected and targeted 13 passed | evidence/web-focused-initial.txt |
| Native full compiler | Uncommitted final snapshot | Zero project diagnostics, installed dependency fallback; binary build pending | evidence/native-compiler.log |
| Desktop full compiler | Uncommitted final snapshot | Zero project diagnostics, installed dependency fallback; packaging pending | evidence/desktop-compiler.log |
| Signed Android artifact and installed critical flow | Pending | Not executed | No build/device result attached |
| iOS signed device candidate and lifecycle checks | Pending | Not executed | No result attached |
| Windows/macOS native packages and hardware checks | Pending | Not executed | No result attached |
| Pending-work upgrade and actual rollback/forward fix | Pending | Not executed | No result attached |
| Web/Android publication and post-release check | Pending | Not executed | No publication asserted |

## Stop conditions

Evidence loss, wrong-Proof media, cross-owner exposure/writes, false saved receipt, unrecoverable promised local work or broken primary capture blocks activation of the affected platform. Preserve originals and diagnostics; disable optional effects first. Do not erase queues/media, downgrade guarantees when capabilities fail, or waive physical checks to meet a release date.

## Gathered local verification limitations

Saved web output confirms production Vite build/typecheck (277 modules) and 13 Home tests. Build reports a 566.36 KB app chunk plus a mixed static/dynamic identifier import warning. These are observed warnings, not performance acceptance or a failed build. Existing installed dependencies were copied from a local cache. Observed Vite 7.3.6 and Vitest 4.1.11 differ from the inspected current manifest requirements Vite ^7.3.7 and Vitest 4.1.12; these initial cached-tool passes did not establish dependency compliance. The final exact web dependency install/build/tests and saved audits below supersede that initial dependency limitation. Final saved outputs are recorded below; earlier outputs remain historical evidence only.

Local build/test outputs bind to the uncommitted workspace snapshot at execution time, not a published release SHA. Subsequent review fixes require affected checks; no local pass closes T01-T14 or AT01-AT28 by itself.

## Gathered shared-source checks

The following actual saved outputs were inspected. They cover the local source snapshot at their recorded execution time, using installed dependency fallbacks; they are not exact-lockfile or physical acceptance.

| Check | Observed result | Saved output |
| --- | --- | --- |
| Canonical token generation/consumer drift | Passed for v1.0.0 and the source digest in the JSON output | evidence/tokens-check.json |
| Desktop full compiler diagnostics | Zero diagnostics with installed dependency fallback | evidence/desktop-compiler.log |
| Motion policy assertions | 4 passed, 0 failed; includes OS preference precedence, capture/station/background suppression, runtime switching and Off | evidence/motion-policy.tap |
| Theme and desktop chronology selectors | 19 passed across 2 files | evidence/theme-and-chronology.log |
| Initial native compiler after token import | 1 project diagnostic: explicit .ts import extension; changed-UI diagnostic count was 0 and helper exit used only that subset | evidence/native-compiler-initial.log |

The native error and internal helper exit criterion were reported for repair. Final corrected native-compiler.log now shows zero full-project diagnostics. A zero process exit or changed-UI subset alone is insufficient. The explicit initial log is retained even if final corrected output replaces native-compiler.log. No row above establishes full T-family or prior AT acceptance.
## Gathered native presentation checks

The native owner's actual current-source rerun output was inspected:

| Check | Observed result | Saved output |
| --- | --- | --- |
| Focused receipt/manual-review/proof-entry/task-home/connected-record/proof-record/scroll-restoration scenarios | 61 passed, 0 failed with installed tsx/dependency fallback | evidence/native-focused-61.tap |
| Changed native UI syntax | 12 files, 0 syntax errors; syntax-only installed TypeScript fallback | evidence/native-ui-syntax.log |

These results do not close full typecheck, binary packaging, installed visual, physical capture/interruption, pending-work upgrade or release gates. The native server-confirmation error now distinguishes actual retained, unavailable and unknown local originals and refreshes when availability changes. Existing canonical receipt predicate/operation ownership remains intact. Source inspection found local cleanup is an explicit receipt-rechecked account action rather than automatic completion-row removal; post-cleanup stale submission routes still require real scenario verification.

## Final gathered local verification checkpoint

This section supersedes earlier current-status descriptions of the cached web dependency mismatch and native import diagnostic; the initial outputs remain preserved. Candidate SHA and remote CI are pending. Later runtime/source changes require affected checks against their own exact revision.

| Verification | Actual observed result | Evidence |
| --- | --- | --- |
| Exact web dependency installation | Root completed npm ci in a clean temporary tree, then used that installed tree; final output identifies Vite 7.3.7 / Vitest 4.1.12 | Final build/test outputs below; release-owner install record |
| Exact web TypeScript + production bundle | Passed; app chunk 568.28 KB with existing mixed-import and over-500-KB warnings; measured performance gate remains open | evidence/web-exact-build.log |
| Exact web focused tests | 28 passed across 7 files | evidence/web-exact-tests.log |
| Web dependency audit | Zero reported vulnerabilities in saved audit scope | evidence/web-exact-audit.json |
| Mobile dependency audit | Zero reported vulnerabilities after targeted security fixes; before report retained | evidence/mobile-audit.json; evidence/mobile-audit-before.json |
| Native full compiler | 0 project diagnostics, 0 changed-UI diagnostics; installed dependency fallback, not a signed native build | evidence/native-compiler.log |
| Desktop full compiler | 0 project diagnostics after final source edit; installed dependency fallback, not packaging/native validation | evidence/desktop-compiler.log |
| Latest native source-review scenarios | 12 passed, 0 failed; supplements earlier 61-test evidence rather than claiming all new files were covered by that earlier run | evidence/native-release-source-review.tap |
| Motion policy | 4 passed, 0 failed using corrected Windows file-URL tsx invocation | evidence/motion-policy.tap |
| Theme and desktop chronology | 19 passed across 2 files | evidence/theme-and-chronology.log |
| Genuine font assets/registration | 3 passed, covering five distinct static weights, names/outlines/license and provider registration | evidence/font-assets.tap |
| Canonical tokens and consumer/output drift | Passed v1.0.0; source SHA-256 a4ea0bdb72812779f94a7905a48b45c8e17cb1120c98d9b41803c1a1bf2fa93b | evidence/tokens-check.json |
| Actual browser component gallery | Observed 390x844 and 1280x720; light/dark Home, heading/gutters/link/receipt fixes, source details, Motion Off and no overflow at those measured sizes | evidence/browser-and-release-review.json |

Browser fixtures were labeled synthetic. No browser camera recording or actual canonical end-to-end Proof was exercised. 320px, runtime 200% text, full assistive-technology tasks, all 27 installed-state comparisons, real phone capture/recovery, old-to-new pending-work upgrade, rollback and actual publication remain Not executed. ADB server now starts but has zero attached devices. iOS signed Mac/device build and Windows/macOS native packaging/acceptance are not established.

The latest native source review added a pure submission-presentation projection over existing CapturePhase and exact operation transport progress. It distinguishes queued, confirmation-needed and actual/unknown original availability, with matching recovery/sign-in actions. Canonical receipt UI identity includes the actual evidence ID and is no longer reset solely by a phase change. Record-source association uses current backend chronology identities and account guards. These repairs retain existing capture/receipt authorities; their 12 focused checks do not replace real-device or server-outcome acceptance.

Practical decision: Go for remote source review/CI and review-build preparation; stop production activation until applicable real-journey, physical capture/recovery/upgrade and release-provenance gates are executed. Existing user web/Android production authorization remains valid; no new broad permission is needed.
