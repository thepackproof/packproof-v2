# PackProof Android G0 source and navigation audit

Prepared 15 October 2026. Read-only source audit for the attached master implementation plan. No production source, backend policy, release configuration or installed app was changed by this audit. G1 founder approval remains a hard stop before production UI implementation.

## Evidence scope and provenance

- Audited checkout: `/workspace/scratch/ba2747541260/packproof-v2`.
- Source: `thepackproof/packproof-v2`, branch `main`, commit `e71461caae5075adaa7b741a3ceec3cd2d9b7d3a`, commit time 14 October 2026 17:20:54 −04:00, subject `fix(android): preserve Expo record annotation for camera recovery storage (#87)`.
- The checkout was clean at audit start; no tag points at HEAD. Main source is verified; equivalence to the founder's installed Android binary is **not** verified. The clone has shallow history, so absence of a local tag is not proof that no release tag exists remotely.
- Configuration declares version `1.0.1`; Android versionCode is an environment override with default 56 and production minimum 62 (`mobile/app.config.js:48–53,93,129`). The production EAS profile explicitly sets versionCode **65** and enables mobile-task UX, first-Proof experience, and production capture receipts (`mobile/eas.json:30–38`). These are configuration facts, not proof of the installed version or the next valid release number. A signed build receipt and installed Settings version are required to close the baseline.
- Older local copies were rejected: `packproof-week2` commit `175594c` (10 October), `packproof-experience` `7f065ab` (29 September), and GitHub-origin scratch checkout `1885d2f` (28 September). The older copies do not even share current navigation behavior.
- Governing local instructions: root `AGENTS.md`, `docs/DEVELOPMENT_PLAN.md`, `docs/architecture.md`. Only one AGENTS.md was found. These preserve one transaction/Proof, server-owned transitions, append-only evidence, authoritative finalization, and the independent V2 repository boundary.
- Baseline CI was independently checked by the parent execution agent for this exact commit: **17/17 checks succeeded**, including Mobile, Backend, PostgreSQL invariants, native consent/recovery, signed Android AAB and Kotlin. The retrieved receipt is `docs/mobile-experience-rebuild-2026-10-15/baseline-ci.json`. These historical CI results establish a stronger source baseline, not physical-device acceptance or matching the founder’s installed build.
- Screenshots S01–S09 establish visual observations; this audit matches them to current source. It does not claim physical-device reproduction, log inspection, build parity, screenshot diffs or measured usability. No personal account data, production evidence, credentials or logs were used.

## Executive finding

The current code already contains a shared task recommendation layer, canonical server presentation, a four-destination bar, durable recovery and mobile-specific composition. A new state machine or broad rewrite is unnecessary. The main opportunities are to finish composing those pieces consistently, shorten the default path, constrain secondary features, and remove remaining divergent entry paths. Some screenshot allegations are not reproduced by the source: tracking is closed initially, and Home already excludes its hero Proof from supporting rows. Those require exact installed-version/state reproduction before being called current defects.

## S01–S09 source map

All locations below are relative to the audited repository. Line numbers describe this commit only.

| Reference | Current route and modules | Verified source finding | Required design / unresolved evidence |
|---|---|---|---|
| S01 Proof evidence | `proof` → `screens/ProofDetailScreen.tsx:48,68–108,270–304`; `ui/ProofRecord.tsx:27,195–220`; `research/ResearchPanel.tsx:21–26`; `research/CaptureReceiptPanel.tsx:50–61` | Evidence body directly mounts ResearchPanel. When production receipt flag is enabled it mounts the capture receipt panel, which includes consent, explanation, refresh/export and source hashes. This is a verified source path for prominent optional technical content. | Move existing receipt capability to an explicit Advanced/Evidence technical details route, retaining consent, source links and exports. Confirm actual binary feature flags before reproducing exact screenshot. Keep required evidence/attestation first. |
| S02 Integrations | `account` + `accountSection:channels` → `screens/AccountScreen.tsx:185–233`; `copy/sales-channels.ts`; `v2-api.ts:742–803` | Manual creation exists; optionality and marketplace authorization explanations are repeated. Provider cards use 20 padding/14 gap (`AccountScreen.tsx:355`); Shopify setup remains a larger inline workflow. Availability is catalog/capability-derived. | Compact provider rows; details/setup only after selection. Preserve actual provider catalog availability, reconnect, automation opt-in and required attribution. No assumption that every connector is live. |
| S03 Profile light | Header modal, not an independent route → `ui/WorkspaceHeader.tsx:26–33,61–85`; `ui/Sheets.tsx:8–35,106–116` | Six profile destinations plus appearance switch, connection status, account name, Close control. Shared sheet has maxHeight 82%, not a mandatory fixed 82% height; content can fill most of it. | Compact list; remove duplicate navigation emphasis; verify safe area, focus trap/return, Back and large type. Do not claim the code explicitly forces full screen. |
| S04 Profile dark | Same modules as S03; `theme/ThemeProvider.tsx`; `theme/tokens.ts` | Shared composition with semantic theme colors. | Verify equal density across themes and readable focus/selected states. The screenshot is not evidence of different business behavior in dark theme. |
| S05 Capture landing | `station` → `screens/WorkspaceOrdersScreen.tsx:23,92–139`; bar mapping `ui/MobileTabBar.tsx:8–13` | Primary Scan shipment, then existing/create/Orders. Shipment heading, filters and search always render even for an empty queue. This matches the reported competing jobs. Horizontal filters exist but physical clipping is not measured here. | Make Pack an item primary, Continue a Proof and Scan secondary; queue only when actual linked orders exist. Keep `station` route ID and native active-station restoration. |
| S06 Shipment | `proof` internal `Tracking` tab labeled Shipment → `ui/ProofRecord.tsx:23,218–223`; `ui/ProofTrackingPanel.tsx`; `ui/TrackingIntake.tsx:13–52` | TrackingIntake initializes `open=false`; seller explicitly selects Add/Manage tracking. When open it renders carrier choices and automatic detection. | Screenshot may show the intentionally expanded form or another build. Do not call it permanently open without reproducing. New design keeps empty summary + Add, and uses one focused form with optional override. |
| S07 History | `proof` internal `Timeline` tab labeled History → `ui/ProofRecordTimeline.tsx:13–99`; detail route `event` → `screens/EventDetailScreen.tsx` | Already groups date boundaries and separates Highlights/Detailed history, with original event details available; margins, nodes, event cards and surrounding header still add density. No fixed full-height timeline item observed. | Compact 56–72dp ordinary events; retain detail expansion and exact event identities. A two-event example will naturally leave unused page space; don't invent filler or stretch rows. |
| S08 Home | `home` → `screens/WorkspaceHomeScreen.tsx:24`; flag true → `screens/TaskHomeScreen.tsx:16–85`; `experience/use-task-home.ts`; `experience/home-adapter.ts:15` | Hero target is excluded from attention/recent rows; hook excludes attention IDs from recent. Titles directly trust `transaction.itemTitle`, fallback Shipment Proof. No explicit email fallback in this path. Stats and recent sections still add several visible actions. | Reproduce duplicate case against installed version. Investigate how itemTitle got its value before blaming email-as-title on a selector. Add a title resolver with provenance, preserving strings explicitly chosen by the user. Hide nonessential counters/recent duplication. |
| S09 Settings | `account` no section → `screens/AccountScreen.tsx:137–175,336–355` | Grouped account/capture settings plus integrations/activity/support/advanced already exist; rows minHeight64 with spacing.lg padding; group cards and identity card increase total vertical space. “Activity” remains in copy even though primary tab is Updates. | Compact sections with consistent Updates vocabulary and direct route continuity. Preserve account deletion, billing, recordings, support and developer access gating. |

## Existing route inventory and retained adapters

`mobile/src/app/navigation.ts:9–118` defines route IDs and Back behavior. `app/Root.tsx:280–316` composes screens. `ui/MobileTabBar.tsx` maps visible Capture to `station` and Updates to `activity`; do not rename public/internal IDs merely to match display copy.

| Current route(s) | Screen/owner | Proposed composition adapter after G1 |
|---|---|---|
| `boot`, `auth` | Root readiness; AuthScreen | Retain auth, session hydration and consent policies; no onboarding obstacle before the first task. |
| `home` | WorkspaceHomeScreen → TaskHomeScreen when flag enabled | Recompose same canonical task model into one hero + distinct new-Proof action. |
| `proofs` | MyProofsScreen | Preserve library state/sort/scroll and `openProofAction`; shared human title/status model. |
| `station`, `orders` | WorkspaceOrdersScreen; active `station` special case mounts PackingStationScreen | Visible Capture uses job-first landing. Existing active station journal bypass must remain intact. Orders remains a profile destination. |
| `activity` | ActivityScreen | Keep pending-original management and selected session routing; display Updates, remove generic unfinished-Proof duplication. |
| `create`, `manual` | CreateScreen, ManualCreateScreen | `Pack an item` should directly select the existing ordinary manual flow; grading/orders remain secondary choices. Preserve recover-submitted-draft handling and idempotency key. |
| `capture` | CaptureScreen + NativeCaptureHost | Reuse existing camera, review and submit coordinator. No separate evidence pipeline. |
| `scan` | ScanScreen / BarcodeScanView | Preserve recognized match and unknown/denied fallback, with no automatic recording. |
| `review` | PurchaseReviewScreen | This route is purchase/import review, **not** the captured-video review. New prototype review must map to CaptureScreen's reviewing mode. |
| `intake` | SharedOrderScreen / native order share | Preserve account-scoped intake queue, defer semantics and reconciliation. |
| `proof`, `event` | ProofDetailScreen, EventDetailScreen | Evidence/History/Shipment remain view-state tabs. Preserve detail stack and scroll/playback restoration. |
| `finalize`, `complete` | FinalizeScreen; completion overlay | Ordinary submit should auto-finalize through existing coordinator when valid. Keep `finalize` for actual required/recovery confirmation. `complete` is declared but no direct body mapping was seen; do not introduce routes that rely on it without a tested adapter. |
| `receipt` | CommerceReceiptScreen | Distinct authorized receiving/return stage; root finalization remains immutable. |
| `invite`, `invitation` | InviteScreen, InvitationReviewScreen | Preserve role authorization and explicit acceptance; viewing is not attesting contents. |
| `sharing`, `signature`, `supporting` | SharingScreen, SignatureProofScreen, SupportingToolsScreen | Preserve links/export/detail/corrections/retention/private-copy affordances behind concise menus. |
| `editPurchase`, `editShipping` | EditDetailsScreen variants | Existing correction permissions govern availability, not presentation assumptions. |
| `account`, `dev` | AccountScreen sections; DevToolsScreen | Preserve sections as compatibility locators; Advanced links to existing allowed tools. |
| `sample` | SampleProofScreen via early Root handling | Keep explicitly synthetic sample and separate it from real personal evidence. |

`normalizeRouteName` only remaps retired `tabs`/`overview` to Home. `resolveBackRoute` retains workspace origins; `showsTabBar` hides the bar during capture and detail routes. Preserve these policies through composition changes and test Back on keyboard, modal, recording, review and local pending original independently.

## Source-of-truth and action pipeline

1. `PackProofProvider.tsx:975–1001` syncs Proof collection, invitation inbox and account-scoped local captures. It tracks freshness/reconciliation separately from data presence.
2. Canonical presentation: `backend/src/domain/proof-presentation.ts:39–97`; mobile `copy/proof-list.ts:24–35` uses server presentation where present and shared classifier as fallback. Local recovery overlays do not commit/finalize.
3. `experience/home-adapter.ts:8–28` converts authorized rows, local captures, jobs and queue entries into `task-home` inputs, including account/API filters and usability checks.
4. `experience/task-home.ts:13–55` ranks local review, interventions, continuation, confirmation and ready orders; unknown/inconsistent statuses reconcile. Passive uploads do not become generic required actions. Finalized roots never receive a new root capture recommendation.
5. `experience/recovery-workspace.ts:14–54` is already shared by Home, Proofs and Updates. It integrates policy-driven photo drafts, scopes original media and keeps counts aligned with destination rows.
6. Execution is revalidated: `PackProofProvider.tsx:1389–1414` `openProofAction` checks invitations, receiver access, offline, drafts and saved original, then refreshes server state. `experience/action-routing.ts:5–15` chooses capture/finalize/proof/receipt using fresh role and canonical presentation.
7. Existing divergence: ordinary participant deep links call `openProof`, not `openProofAction` (`app/Root.tsx:201–210`). History-share deep links intentionally open signature view. Home recent rows similarly use a plain viewer (`experience/use-task-home.ts:59–65`). The list's actionable row uses `openProofAction` (`screens/MyProofsScreen.tsx:70`). Notifications also use it (`PackProofProvider.tsx:1239`). Thus “all unfinished entries reach the identical next step” is not yet guaranteed by one entry router.
8. Proof detail still derives a legacy `deriveNextAction` alongside canonical presentation (`screens/ProofDetailScreen.tsx:72–108`). Treat this as a narrowing/refactor candidate; do not replace canonical server presentation or grading's server nextAction.

Recommended post-G1 seam: a small mobile `openProofDestination({proofId, intent: resume|view|historyShare, source})` adapter that calls the existing validated owners. Human “View evidence” links may explicitly request viewer; unfinished resume links use resume. Keep intentional public viewer/history-share semantics, account checks, diagnostics and local playback intact. Add a shared `proofDisplayTitle` that consumes title provenance when available; unknown/provided email-like text must not silently be destroyed. Do not promise a backend provenance field unless it exists or separate approval is obtained.

## API, state and permission inventory

| Surface | Verified client APIs / data | Permission and policy boundary |
|---|---|---|
| Home/Proofs | `GET /me/proofs`, `/invitations`, optional `/me/fulfillment-queue`; `v2-api.ts:725–815` | Account-authenticated catalog; local original filtered by user + API. Cached classifications are guidance, never permission. |
| Manual create | `POST /transactions`, then `/transactions/:id/proof`; `PackProofProvider.tsx:1810–1875`, `v2-api.ts:902,1040` | Online creation; persistent operation/idempotency before request. Existing unacknowledged creation must reconcile before another. |
| Capture preflight | `/capabilities`, `/proofs/:id/capture-sessions`; `capture/preflight.ts:7–27`, `v2-api.ts:1136` | Native recoverable-camera availability, server capabilities, applicable biometric readiness, storage, server session allowance/time/byte limits. See existing capture-contract document; no paywall/credit-policy change. |
| Camera permissions | `app.config.js:137,153–162`; camera module AndroidManifest | Ordinary production declares CAMERA; RECORD_AUDIO only opt-in camera spike. Do not request microphone permission as a default new requirement. Notification permission is separate. |
| Review/submit | CaptureScreen:137–178, seller-attestation.ts, capture/completion.ts | Playable original, shipping/identifier review when required, explicit seller declaration/signature; account, Proof, capture and hash binding. Local playback does not authorize upload. |
| Finalize | `POST /proofs/:id/finalize`; `v2-api.ts:1312`; backend finalize-requirements.ts:29–111 | Seller joined; no pending evidence; applicable `FULFILLMENT_CAPTURE` and packing attestation. Counterparty-required remains distinct. Grading evaluates its separate item/custody prerequisites. |
| Evidence/history | `GET /proofs/:id`, returned chronology/events/evidence, manifest, authorized media URLs | Participant authorization; private/scoped exports and original hashes unchanged. Chronology formatting is presentation-only. |
| Shipment | `POST /proofs/:id/tracking`, transaction shipment sync, shipment identity/events; `v2-api.ts:955–963` | Current UI Add/Manage tracking seller-only. Saved tracking ≠ video observation, finalization or carrier acceptance. Existing correction/API gate governs writes. |
| Updates | `/me/notifications`, notification read endpoint, local capture recovery | Scope original files to same API/account; independent notification fetch failure must not hide durable recordings. |
| Integrations | `/me/connected-accounts`, integration connections, commerce automation/sync | Returned provider enabled/capability fields determine available actions. OAuth connection is separate from login; not proof of fulfilled/shipped order. |
| Profile/billing/privacy | `/me/profile`, billing panel, `/me/account-deletion-request` | Server billing/entitlement policy retained; deletion remains explicit request and status flow, not local data wipe. |
| Advanced | Developer capability, signature/lifecycle/retention/disclosure/research API methods | Existing server authorization and feature flags remain. Relocating advanced UI never grants access. |

## Protected capability ledger

“Present in source” does not assert deployed operational availability or device acceptance.

| Capability | Existing owner/path | Preserve / confidence |
|---|---|---|
| Continuous original and local recovery | `capture.ts`, `capture/completion.ts`, `capture/recovery-model.ts`, `capture/upload-recovery.ts`, `ui/NativeCaptureHost.tsx`, native unified-camera module | Present. Retain journals, account binding, original file, idempotency, interruption truth. Installed force-stop tests still needed. |
| SHA-256/commit/finalization | Backend domain finalize/evidence plus client completion owner | Present architecture; no cryptographic or contract edits in UI work. Independent integrity audit/test evidence is separate. |
| Ordinary manual Proof | CreateScreen → ManualCreateScreen → provider createManualProof | Present; marketplace-free path. Reduce decisions without deleting grading/order choice. |
| Packing Station and batch recovery | WorkspaceOrdersScreen, PackingStationScreen, `packing-station/submit.ts`, special Root branch | Present. Preserve current/restored station session and order deduplication. |
| Receiving and return stages | CommerceReceiptScreen, `v2-api.ts` lifecycle methods | Present. Keep append-only stages and receiver grant distinct from root capture. |
| Grading/item photos/custody | CreateScreen grading branch; PhotoCaptureFlow; ProofDetail server nextAction; backend grading rules | Present. Keep policy-driven photos for grading; never make them default mandatory ordinary packing steps. |
| Shared order / remote station | `intake/`, SharedOrderScreen, `relay/RelayStationHost.tsx` | Present. Keep native share defer/restore and pairing routes in Advanced. |
| Tracking & shipping observations | TrackingIntake, ProofTrackingPanel, tracking connection/state helpers | Present. Runtime provider capability remains unknown from source alone; architecture docs contain historical provider limitations and cannot establish live rollout. |
| Signed optional receipt | `research/ResearchPanel.tsx`, CaptureReceiptPanel, ReceiptConsent, isolation.ts | Present, feature flagged. Move intact to discoverable advanced surface; preserve truthful assurance caveat. |
| Evidence viewer/bookmarks | ProofEvidencePreview, SignatureProofScreen, signature modules | Present. Preserve authorized originals, exact source association, playback restoration. |
| Sharing / exports / claims preparation | SharingScreen, EvidencePackageButton, `signature/RecipientExportPanel.tsx`, CasePacketPreview | Present. Keep explicit scopes, permission reviews, source verification and export paths. A claims preparation UI is not a live Zendesk/Salesforce integration. |
| Responses/corrections/retention/private copies | SupportingToolsScreen + supporting modules | Present. Preserve append-only support flow and authenticated access. |
| Developer API controls | Account Advanced → DeveloperAccessPanel gated by useDeveloperAccess | Present. Retain server-confirmed entitlement; no broad visibility assumption. |
| Notifications / account / billing / deletion | ActivityScreen, NotificationCenter, AccountScreen, BillingPanel | Present. Preserve all paths and plan policy. |
| Witness | No dedicated mobile witness flow found in audited mobile tree | Unverified; do not advertise as shipped or delete related API/domain capability based on this negative search. Clarify current inventory with live/source owner before parity sign-off. |
| Desktop, web, iOS | Existing sibling surfaces and native modules | Out of scope for visual rebuild. Shared backend classifier imports mean changes there could affect other clients; mobile adapter is safer. |

## Risk register and closing evidence

| Risk | Severity / current status | Required closing evidence |
|---|---|---|
| Source does not match installed screenshots | High, open | Installed versionCode, commit/build provenance and recreated anonymized S01–S09. |
| Mixed viewer/resume entry semantics | High, source-confirmed divergence | Same authorized fixture opened through Home/list/notification/deep link; intended viewer exceptions explicit. |
| Multiple next-action derivations | Medium, source-confirmed | Deterministic matrix for seller/buyer/receiver/grading, pending stage, local interrupted/queued, finalized elsewhere and stale cache. |
| Email-like itemTitle | Medium, origin unresolved | Redacted fixture/source provenance or user-selected title; shared display contract test. Do not log full emails. |
| Empty Capture queue UI | Medium, source-confirmed | 0-order screenshot has primary manual entry and no empty filters/search; many-order case retains accessible scrolling. |
| Advanced receipt dominates Evidence | Medium, source-confirmed when enabled | Receipt remains two taps away, all consent/export functionality preserved, primary evidence state first. |
| Generic unfinished Proofs duplicated into Updates | Medium, source-confirmed in ActivityScreen:65–69 | Actionable events/errors feed design; all pending media still reachable; count semantics retained. |
| Biometric/capability/allowance surprise after packing | High, control present but real device unverified | Physical preflight denial/success, actual policy cap and exact review authorization. |
| Flag rollback or route transition loses original | Critical, untested here | Toggle presentation on internal build with queued same-account recording; original and idempotent resume survive. |
| API/legal policy overclaimed from historical docs | High, unresolved runtime state | Current capabilities + staging/server contract verification; no policy modifications to make mockup fit. |
| Large text/sheet/tab clipping | High if essential controls blocked, physical behavior unmeasured | 320/360/393/411dp; 1/1.3/2 font; keyboard/safe area; TalkBack focus and restoration. |

Existing rollback hook: `experience/mobile-ux.ts` defaults `EXPO_PUBLIC_PACKPROOF_MOBILE_TASK_UX` on unless explicitly false; first-proof flag is separate. This is a build/environment composition switch, **not evidence of a remotely instant toggle**. Rollback requires a known tested build/config and journal compatibility rehearsal. Do not restore an old binary across newer journals without verifying schema compatibility. Existing recovery owners remain unchanged during a presentation rollback.

## Proposed post-G1 slices and effort bands

Relative S/M/L describes scope/risk, not promised duration. Owners are proposed roles, not claims that staff have been assigned.

| Package | Size / owner | Smallest useful scope and validation |
|---|---|---|
| UXR-02 mobile composition primitives | M / mobile engineer + design | Reuse AppScreen, Button, BottomSheet, CompactProofRow, theme tokens; add only missing focused layout/progress primitives. Render both themes + 200% type. |
| UXR-03 title/action adapter consolidation | M / mobile engineer + domain reviewer | Narrow adapter over recovery-workspace and fresh action routing; no backend classifier rewrite. Test cross-entry equivalence and completed/unauthorized behavior. |
| UXR-04 manual first-Proof slice | L / mobile engineer + device QA | Direct ordinary path, description → issued-session preview → continuous capture → actual review/declaration → authoritative finish. Keep operation and queue owners. Physical start-to-finalize video. |
| UXR-05 Home/catalog/detail | M / mobile engineer + design | Recompose existing selector outputs and shared title; single hero + at most three distinct rows; exact status and viewer handling. Screenshot fixture evidence. |
| UXR-06 recovery/status surfaces | L / mobile engineer + reliability QA | Reuse current durable system, simplify truthful local/queued/bytes/server/finalized UI. Force-stop, auth loss, account switch, other-device finalize and rollback checks. |
| UXR-07 scan/order/roles | L / mobile engineer + API reviewer | Keep station route adapter and all special journals; job-first entry; optional queue, scan fallback, buyer/receiver/grading authorization matrix. |
| UXR-08 secondary destinations | M / mobile engineer + design | Compact History, two-state Shipment, event-led Updates, small profile/settings/provider rows and Advanced receipt relocation. Capability ledger recheck. |
| UXR-09–10 verification/build | L / QA + release engineer | Targeted source tests after each slice, then signed internal Android candidate with real device A/B matrix, accessibility and usability dossier. G4 remains separate approval. |

G0 remains **source-audit complete, installed baseline incomplete** until build identity and physical reproductions exist. Existing model/unit tests named in source (`task-home`, `recovery-workspace`, `proof-navigation`, `manual-operation`, `capture-recovery`, `upload-handoff`, `capture-limits`, `proof-record`, `proof-tracking`) are reusable starting points. The separate baseline-CI receipt reports historical passing CI; this read-only audit itself did not execute those suites or physical-device scenarios. G1 prototype can be reviewed with these limitations visible; neither the prototype nor this report authorizes production UI implementation or a public release.
