# First Proof experience: acceptance and device checklist

Date: October 11, 2026. Integration base: `0424f154edc1bcbd97f463f3a64e90e109d67e87`; implementation branch: `feature/first-proof-experience`.

The user subsequently authorized urgent production release and deferred their physical testing until after deployment. That changes release sequencing; it does not convert unperformed device or human tests into passes. Record actual deployed commit, backend image, website artifact, Android version/code and installer SHA-256 in the release receipt. A JavaScript export is not an installed native-build pass.

## Evidence already obtained during primary implementation

The counts below record the earlier primary implementation checkpoint, not the final follow-up suite inventory. For later evidence, use [MEASUREMENT.md](MEASUREMENT.md), [NATIVE_MEASUREMENT_EVIDENCE.md](NATIVE_MEASUREMENT_EVIDENCE.md) and [DESKTOP_DRAFT_RECOVERY_EVIDENCE.md](DESKTOP_DRAFT_RECOVERY_EVIDENCE.md). In particular, the final desktop recovery check passed 105 tests; the earlier 94-test result below belongs to its stated primary checkpoint. The exact release receipt and successful source-bound CI remain authoritative for what shipped.

- Native TypeScript check passed after first-use, task intent, sample and idempotent draft changes.
- Native focused tests passed **36/36**: `manual-operation`, `first-proof-intent`, `task-home`, `proof-navigation`, `workspace-summary`.
- Capture agent reported **27/27** capture/recovery tests passed. See its final validation record for exact executed suites and native camera limit changes.
- Android and iOS JavaScript/asset exports passed, including the bundled 2.66 MB public sample. These are not signed native installers or native camera compilation results.
- Desktop typecheck, application build, and **94/94** tests across 12 files passed. The local sample video is emitted as an application asset. Installed desktop playback has not been tested.
- Backend and web evidence must be taken from the final integration run and release receipt. This document does not infer their results from source changes.
- No physical-device, TalkBack/VoiceOver, performance percentile, or unassisted-participant result has been recorded for this candidate in this document.

## T01–T28 traceability

“Automated component” means the named contract/model is tested, not the whole installed user journey. Every physical row remains pending until a device evidence entry exists.

| Test | Implementation / automated component | Outstanding acceptance evidence |
|---|---|---|
| T01 fresh Home | `selectTaskHome`, `selectFirstExperience`, native/web Home; new flow disables automatic tour | Fresh installed account, loading and failed refresh video |
| T02 minimum manual Proof | One required description; durable manual operation key; backend create-or-get | Physical record, consent/signing, commit, authoritative finalization |
| T03 authentication return | Scoped `task-intent`; email/code autofill; profile deferred | Wrong/expired code, resend, app restart and successful return |
| T04 linked order | Existing canonical order resolution; no title-based merging | Real supported linked order selected twice, same root |
| T05 sample/help | Public local fixture, existing video/timeline; voluntary tutorial | No sign-in, camera, debit, sharing or production activation after sample |
| T06 intentional single take | Existing capture host; no automatic recording on restore | Record only starts on explicit control; no mandatory scan/photo |
| T07 label observations | Existing label review and immutable source handling | Missing/conflicting label on physical recording |
| T08 declaration | Existing stage-specific consent and signing retained | Cancel signing, retake and changed fields require valid consent |
| T09 completion | Existing coordinator; Home says Continue submission | Normal authorized capture finishes without redundant confirmation; rejected finalization stays pending |
| T10 entry roles | Scoped receipt/invitation/signature locators and existing authorization | Receiving/return/viewer entry across sign-in on installed build |
| T11 capabilities | Profile, Integrations, advanced tools, library, Pack and Activity routes retained | Focused operational feature inventory on deployed build |
| T12 old/reinstalled account | Server-derived first finalized packing; old preference fields preserved | Reinstall/second device; no claim that local original synced |
| T13 Home priorities | `task-home` and native adapter tests; stable ties and account filters | Stale target tap, queue refresh failure and passive upload on device |
| T14 desktop/mobile web | Same domain/capture owners; responsive surfaces retained | Final web suites and desktop browser acceptance receipt |
| T15 permission denial | Existing preflight/denial flow; form stays account scoped | Deny/revoke camera and microphone; reopen task |
| T16 offline | Home permits local review, server-only create remains blocked | Disconnect before create, during capture and during upload |
| T17 kill during recording | Existing file journal recovery; no auto record restart | Force stop during physical recording; inspect recovered state |
| T18 kill at local handoff | Existing durable local journal and reconciliation tests | Kill before/after job persistence; same original/job recovered |
| T19 lost server responses | Idempotent manual creation plus existing commit/finalize reconciliation | Inject dropped upload/commit/finalization response |
| T20 storage/corruption | Existing local-file inspection and server integrity checks | Full storage, revoked file access and corrupt-media fixtures |
| T21 auth/challenge expiry | Retained account task and media; original authority rechecked | Expired upload grant and signing challenge on device |
| T22 replay/concurrency | Stable draft operation key; canonical one Proof per transaction | Double tap, response loss, second-device completion, ledger evidence |
| T23 account switch | Scoped cache/journal/task keys; foreign capture adapter excluded | Queue under A, sign in B, then A; no preview/upload/content leak |
| T24 signing cancellation | Existing explicit attestation path unchanged | Denial/cancel retains file; changed consent cannot finalize |
| T25 forged success/integrity | Existing domain-owned finalization; unknown state never completed | Digest/attestation rejection against candidate backend |
| T26 platform interruptions | Copy says keep app open; worker may be suspended | Native background/suspend/force-stop and browser refresh/closure separately |
| T27 accessibility | Autofill/show-password, 48-point controls, existing reduced motion | TalkBack, VoiceOver, keyboard, largest text and small-screen pass |
| T28 rollback | Compatible task schemas and same local journal/coordinator | Old-composition candidate opens queued upload and pending finalization |

## Galaxy S24 Ultra: first hands-on pass

Use the exact intended candidate; record Android/One UI version, app version/code and source commit before starting. Use a harmless test item and label without real recipient details. Record consented screen evidence and results; never include credentials, biometric details or raw recipient data in the issue report.

1. Open signed out. Open **See a sample Proof**, play/pause and switch to Activity, then close. The sign-in state should return and no permissions should have been requested.
2. Create or sign in to a fresh eligible account. Paste/autofill the code/password and exercise Show/Hide. Cancel and retry verification. No business-name/profile/integration step should block the first Proof.
3. Wait for Home to settle. Capture the initial/loading state and resulting Create Proof card. A known-empty account should have no empty totals. A failed refresh must not claim a new or completed account.
4. Tap Create Proof; enter a short item description; use Back and return. Confirm the draft remains. Continue to camera; inspect entitlement/readiness information before physical packing.
5. Deny camera permission once, recover through the offered setting, then return. Confirm the same draft/order remains. Only tapping Record starts capture.
6. Record one continuous sequence showing the item, packing and sealing. Finish recording, review the exact video and declaration, then Confirm and submit. Exercise required biometric signing normally. The app must distinguish saved on device, uploading, committed and finalized.
7. Keep PackProof open for this first transfer. Wait for server-confirmed finalization, open the finished record, replay original evidence and inspect sharing. No automatic public share should exist.
8. Begin a second Proof. Confirm beginner guidance does not return after first finalization and Home still exposes outstanding work before Create Proof.
9. With another safe test recording, interrupt the network during transfer. Open Activity. Restore connectivity and verify the same file/job resumes, without a second recording or duplicate root.
10. In separate trials, background, suspend, force-stop after save, and restart. Record the precise point of interruption. Treat a stop during recording separately from a stop after durable save.
11. Queue a test recording in account A; sign out and into B. Confirm B cannot view or resume A’s draft/media. Return to A and verify its recoverable work.
12. Turn on TalkBack and largest text. Repeat Create, review, declaration and recovery with understandable labels, visible errors and reachable controls. Test reduce-motion settings separately.

If an acknowledged original disappears, another account sees it, a rejected submission displays success, signing can be bypassed, or a duplicate debit occurs, preserve the evidence and stop expanding the candidate. Use a compatible presentation rollback; do not delete application data to “repair” the trial.

## Result entry template

`Test ID | UTC timestamp | device/OS | app version/code | source commit | account fixture alias | network state | exact steps | expected | observed | PASS/FAIL/NOT RUN | redacted evidence path`

The founder test is useful acceptance evidence. It does not replace the plan’s two formative rounds of five participants and release-gate round of ten fresh participants. Those rounds, conversion baseline, timing percentiles and status-comprehension thresholds remain unmeasured until performed.
