# PackProof mobile experience rebuild — review packet

**Current status: G1 approved; Android code slices are in draft PRs and the internal APK is built. Native acceptance and G4 release authorization remain open.**

Start with [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md), [VERIFICATION_REPORT.md](VERIFICATION_REPORT.md), [INTERNAL_BUILD.md](INTERNAL_BUILD.md) and the current [NATIVE_ACCEPTANCE_MATRIX.md](NATIVE_ACCEPTANCE_MATRIX.md). The founder's “Excellent, proceed” approved the frozen G1 revision and authorized implementation. The prototype and earlier G0/G1 documents below remain historical design evidence; they are not native acceptance results or a claim that the full plan is complete.

## Review order

1. Open `prototype/index.html` in a modern browser. It is self-contained and sends no data to an API.
2. Run the manual first-Proof journey: create, identify item, continuous recording simulation, review, explicit declaration/signing simulation, upload, received, server-finalized.
3. Run saved-original recovery: an interrupted upload retains its local original; retry/reconcile the existing Proof without re-recording. Compare a truly interrupted recording with an intact recording whose upload was interrupted.
4. Review all destinations, then repeat in dark theme and large type. The design controls are outside the simulated phone.
5. G1 approval is recorded in `IMPLEMENTATION_STATUS.md`. G4 public release remains separate and requires the exact native build and acceptance evidence.

## Evidence and scope

Source baseline: `thepackproof/packproof-v2` at `e71461caae5075adaa7b741a3ceec3cd2d9b7d3a` (14 October 2026). Branch: `ux/android-task-first-rebuild`.

- `G0_NAVIGATION_AUDIT.md`: current source inventory, S01–S09 findings, existing action/route owners, capability ledger, rollback boundaries and slice estimates.
- `G0_EVIDENCE_AUDIT.md`: evidence and policy boundaries, local queue/recovery, attestation and acceptance status.
- `baseline-ci.json`: retrieved historical CI results for the exact source baseline, 17 successful checks.
- `baseline-model-tests.log`: fresh local run of 104 existing tests, all passing. Model tests do not stand in for a camera or force-stop test.
- `prototype/`: deterministic design, exact copy/state definitions, verification and reproducible PDF export scripts.
- Private review includes the screen atlas, redacted S01–S09 comparison and one-page core copy dictionary. Supplied screenshot assets are excluded from this public repository.

The source baseline is verified. Its equivalence to the installed Android binary shown in the screenshots is not verified. Production configuration currently declares versionCode 65; configuration alone is not installed-build evidence. The public source packet contains no real account, evidence or personal screenshot. The private comparison PDF uses redacted references from the supplied document.

## Design and engineering decisions

| Decision | Reason and implementation boundary |
| --- | --- |
| Reuse the existing task/recovery model | `recovery-workspace`, `task-home`, `home-adapter`, canonical presentation and `openProofAction` already exist. Consolidate their use rather than creating another authoritative state machine. |
| Direct ordinary manual path | Ordinary packing uses one continuous video. Grading and policy-driven supplementary photos remain separate, discoverable flows. |
| Retain explicit native declaration/signing | Use the exact current statement and media/Proof binding. Signing in the prototype is clearly simulated; runtime server policies are not inferred from fixtures. |
| Treat local, upload, received and finalized as distinct | A durable local file, transfer progress or saved tracking number cannot establish server finalization. |
| Fix divergent resume entry points | Current participant deep links use viewer routing while lists/notifications use action routing. A thin intent adapter must preserve explicit view/history links and validate actual resume actions. |
| Keep title provenance honest | The source forwards itemTitle. Its email-like origin is unknown. Preserve explicitly chosen strings; do not invent a backend provenance field. |
| Preserve tracking closed-at-rest behavior | Current source already initializes the tracking form closed. The reference screenshot may show an expanded state or different binary; it is not proof of a permanent form defect. |
| Preserve account/role and advanced capabilities | Relocate optional receipts and advanced tools with clear routes, retaining consent, source attribution and export/access rules. |
| Rollback is a build/config mechanism | The existing public environment flag is not a demonstrated live remote toggle. Rehearse journal compatibility before any rollback. |

## Gates still open

| Gate | Current result | Missing evidence |
| --- | --- | --- |
| G0 | Source audit and automated baseline complete; device baseline incomplete | Installed build identity and anonymized matching S01–S09 reproduction/real task recordings. |
| G1 | Approved for the frozen revision | See the approval record and unchanged prototype hash in `IMPLEMENTATION_STATUS.md`. |
| G2 | Code slices and automated checks ready for review; not signed off | See exact artifact evidence in `VERIFICATION_REPORT.md`; native journey and production-equivalent optional receipt parity remain open. |
| G3 | NOT RUN | Physical Android matrix, TalkBack, native screenshot comparison, two-device recovery and five unassisted users. |
| G4 | Not authorized | Exact-build founder approval, rollout/rollback rehearsal and release dossier. |

No store submission, backend modification, billing change, iOS adaptation, desktop migration or public PackProof website deployment is part of this rebuild.

## Remaining acceptance work

Execute the current native matrix on physical Android, collect the five complete journey videos, establish and approve the native screenshot baseline, complete accessibility and unassisted usability, and rehearse compatible UI-only rollback. Resolve defects and production-equivalent receipt parity before requesting G4 approval for an exact artifact. No fixed schedule or native result is inferred from compilation or model tests.
