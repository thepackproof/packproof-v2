# Source, capability and platform baseline

Inspection date: October 24, 2026. Observations below come from the retrieved repository source and supplied design ledger, not from authenticated installed applications. Fields marked pending must be reconciled before a release claim.

## Source authority

| Item | Observed fact | Remaining reconciliation |
| --- | --- | --- |
| Repository | thepackproof/packproof-v2; default main; independent V2 repository | Main/archive baseline b08daf7982bedb6916702b5e4ee237a314f726da confirmed by release owner; candidate commit pending |
| Local source | GitHub main source archive extracted for implementation | Official public codeload archive downloaded through Node fetch. Local reconstruction baseline da5feca is a synthetic local commit, not an upstream SHA. Candidate source remains uncommitted at this checkpoint. |
| Repository rules | Root AGENTS.md points to docs/DEVELOPMENT_PLAN.md and docs/architecture.md; legacy repository is outside scope | Preserve canonical invariants and intervening fixes |
| Historical website merge | Plan identifies PR #128, b08daf7982bedb6916702b5e4ee237a314f726da | Historical anchor only; current candidate/deployed SHA pending |
| Hosted app | .openai/hosting.json identifies appgprj_6a9c2365007c8191a0958c54e4a67b95 | Actual hosted source 5b454f836872cc9292b4b12fc4709674bb5c2d37; current public saved version 62; candidate reconciliation pending |
| Hosted source split | docs/EVIDENCE_IN_MOTION_IMPLEMENTATION.md records distinct GitHub and Sites trees and recovered hosted commit 9924fae9764e7a0a337bfb3b9467a8af27aa6203 | Do not replace full hosted source with repository website snapshot; reconcile auth, API bridge, public content and live additions |
| Backend | Domain authority lives in current server contracts; /meta exposes configured release identity | Release owner identifies production backend revision 399f306, unchanged by this presentation work; live capabilities and authenticated commands remain unverified. |
| Design | New page 22:1921 in historical file 4AtxdZJxHvpWVF3cCX14Z0; named EIM v1, 2026-10-24 | Immutable history ID unavailable; see design-contract.md for limited final screenshot evidence |

## Current source declarations

| Platform | Declared source/runtime | What is not established |
| --- | --- | --- |
| Web | React 19.1.x, Vite 7.3.7 range, TypeScript; package-lock.json; no dedicated motion dependency in inspected manifest | Installed dependency tree, candidate build, browser interactions and production state |
| Mobile | Expo ~53.0.27, React Native 0.79.6, React 19.0.0; package-lock.json; camera/file/video/font/haptics present | Native compatibility, real camera/audio/file behavior and signed candidate |
| Desktop | Electron 44.4.5, React 19.1.1, desktop version 1.0.3; package-lock.json | Candidate packaging, installed version, signed/notarized release and hardware checks |

No dependency upgrade, camera/uploader rewrite, new backend program, required extra photos, new pricing or retention promise is part of this presentation scope.

## Existing owners and boundaries

| Concern | Existing integration points | Binding requirement |
| --- | --- | --- |
| Web composition | web/src/App.tsx; web/src/proof-presentation.ts | Scope app styles; use current canonical presentation/commands |
| Web durable work | web/src/capture-queue.ts; web/src/capture-preflight.ts | Screens observe queue; do not own/restart it |
| Native navigation and authority | mobile/src/app/Root.tsx; navigation.ts; PackProofProvider.tsx | Exact environment/owner/Proof/take/operation and stale-result guards |
| Native capture and durability | mobile/src/capture.ts; capture/engine.ts; capture/preflight.ts; recording-review.ts; recovery-model.ts; upload-recovery.ts; recover-completion.ts | Preserve native lifecycle, consent, selected/candidate takes, local validation, same-operation reconciliation and receipt-gated cleanup |
| Native presentation | mobile/src/experience/* and existing theme modules | Adapt pure status/next-action mappings; do not create domain authority |
| Desktop renderer | desktop/src/renderer/App.tsx; presentation.ts; ProofDetail.tsx; PackingStation.tsx | Reuse eligible visual semantics; retain keyboard/scanner and native ownership |
| Desktop privileged owner | desktop/src/main/evidence/engine.ts; evidence/store.ts; preload.ts; security.ts; shutdown.ts; updates.ts | Preserve validated IPC, context isolation, credentials/files, close/sleep and upgrade behavior |
| Canonical server | backend/src/domain/proof-presentation and current API/domain services | Client never writes canonical status or treats local/upload state as Proof state |

Current journal/storage format versions, migrations, receipt-mode capabilities and source-bound confirmation predicates must be inventoried from these owners and verified with pending-work upgrade scenarios. No journal schema change is authorized merely to simplify a screen.

## Route and feature preservation inventory

Observed native route union: boot, auth, sample, home, proofs, orders, activity, create, account, sharing, signature, supporting, proof, submission, capture, scan, intake, receipt, manual, review, finalize, complete, invite, invitation, station, dev, editPurchase, editShipping, event.

Observed account sections: developer, billing, notifications, profile, channels, recordings, appearance, help, privacy, advanced. Preserve all reachable supported functions, including import/grading entry, buyer/recipient/return workflows, sharing/export, edits, invitations, connected accounts and deletion/sign-out safeguards. The source union is an inventory, not proof of present control reachability. The candidate audit must cover web and desktop equivalents and every visible control.

Main app navigation remains Home / Proofs / Activity, with account settings at the avatar; supporting tools remain reachable. Station remains Scan -> Ready to pack -> Record -> Done. Capability-dependent merchant, carrier, claims/export and administration features must be gated by deployed server authority, not a visual role switch.

## Release identity and access

Observed mobile app.config.js declares package/bundle com.packproof.mobile, Expo owner packproof-llc, version 1.0.1. The inspected production EAS profile declares Android versionCode 71 with source-bound configuration and existing remote signing. These values are source declarations, not the currently installed or live Play identity. Reconcile live Play versionCode before allocating a strictly newer candidate; preserve the existing signing identity.

The Android AAB workflow includes release policy, type/behavior/security/font/provenance gates and verifies EAS source SHA, package/version/channel and upload certificate. It builds an actual .aab; build success is not Play production publication. Existing submit profile shown in eas.json targets internal only; production release must explicitly select and verify the correct channel/status.

Local GitHub CLI authentication was reported invalid and direct clone failed in this session; the connected GitHub account showed repository administration/push access. Do not expose credentials or place them in the packet. Available signing, Expo/Play/iOS/Sites operator access and real-device access require the release owner's concrete evidence.

## Required baseline measurements still pending

Record device/OS, release build SHA, theme, network/storage conditions, media duration/resolution and sample count. Measure startup/workspace-ready, camera-ready, native stop-to-readable-file, review-ready, action latency, frame time and repeated-cycle memory. Ratify proposed budgets against noise: feedback within 100 ms; no deliberate capture delay; investigate startup/camera/review regressions larger than 10% or 100 ms; simplify decoration before compromising core tasks.


## Candidate implementation checkpoint

GitHub main baseline: b08daf7982bedb6916702b5e4ee237a314f726da. Actual hosted source baseline: 5b454f836872cc9292b4b12fc4709674bb5c2d37, saved version 62, public https://thepackproof.com. Local reconstruction da5feca is not upstream. Hosted-source reconciliation is separate from the repository source.

Web presentation source is implemented in mobile-task/MobileHomeScreen and MobileNavigation; signal/Signal, signal.css and EvidenceSources; components/WorkspaceProofRecord and ConnectedChronology; Account motion settings, ProofScreen and stable PackingStation motion suppression. Native source is implemented in SignalHomeScreen, SignalSubmissionScreen, CaptureScreen, AccountScreen, Root, ui/Signal, SignalProofRecord, shared controls and copy/eim-record.ts. Existing queue/provider/native capture owners remain authoritative. iOS shares source but has no signed-device acceptance. Desktop renderer source is implemented in SignalDesktop, evidence-in-motion.css, motion.ts and App/main wiring without privileged bridge changes.

ADB daemon startup currently fails in the available shell. IAB is available for web review, while the prior Edge session is closed. Actual devices, installed versions/signatures, Expo/Play signing/operator access and candidate release identity remain pending. Source implementation does not establish real-operation, native, visual, upgrade or publication acceptance.

## Final baseline/access checkpoint

Live /api/meta was observed at production commit 399f306a2fdac37511c8659c73d5a059dd759b7a, version 1.0.3-m2-bridge-399f306a; backend unchanged. Play was verified for package com.packproof.mobile: production 1.0.1 versionCode 71 at 100%, latest uploaded code 71, managed publishing off, existing one-country scope unchanged. Candidate source production code is now 72; no candidate signed build/submission is established.

ADB daemon startup was subsequently repaired through the host runtime. The current blocker is zero attached physical devices, not a remaining daemon-start failure. Signed iOS Mac/device and Windows/macOS native build/hardware/upgrade access remain unexecuted. Browser gallery review used measured 390x844 and 1280x720 and Motion Off; real web capture/canonical journey and comprehensive accessibility/performance remain pending.

Canonical package: packages/evidence-in-motion/tokens.v1.json, generate-tokens.mjs, tokens.generated.ts and tokens.generated.css. Genuine Medium/ExtraBold assets now fulfill source typography targets; installed fidelity is still a separate gate. Exact web clean-install/build/test and audit evidence supersede the initial cache mismatch. Mobile/desktop compiler output uses installed dependency fallback; no signed native build is implied.
