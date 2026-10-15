# PackProof mobile experience rebuild — G0/G1 review

**Status: design review, awaiting explicit G1 founder approval. No production UI implementation or release.**

This packet executes the pre-implementation portion of the 15 October 2026 master plan. The controlling document requires a clickable design and explicit written `G1 approved` before production screens are changed. This is a separate design fixture, not a new evidence pipeline, Android build, or claim that the complete development plan is finished.

## Review order

1. Open `prototype/index.html` in a modern browser. It is self-contained and sends no data to an API.
2. Run the manual first-Proof journey: create, identify item, continuous recording simulation, review, explicit declaration/signing simulation, upload, received, server-finalized.
3. Run saved-original recovery: an interrupted upload retains its local original; retry/reconcile the existing Proof without re-recording. Compare a truly interrupted recording with an intact recording whose upload was interrupted.
4. Review all destinations, then repeat in dark theme and large type. The design controls are outside the simulated phone.
5. Record `G1 approved` for this exact revision, or list changes. G1 approval authorizes the next implementation slices; G4 public release remains separate.

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
| G1 | Reviewable design candidate | Founder review of two complete journeys, annotated state coverage and deviations, and explicit written approval. Review prototype verification for remaining scope and renderer/device limitations; this candidate is not a gate-completion certificate. |
| G2 | Not started | Approved production slices, internal APK, full parity and integrity regression. |
| G3 | Not started | Physical Android matrix, TalkBack, two-device recovery and five unassisted users. |
| G4 | Not authorized | Exact-build founder approval, rollout/rollback rehearsal and release dossier. |

No native build, store submission, backend modification, billing change, iOS adaptation, desktop migration or public PackProof website change is part of this commit.

## Next authorized work after G1

Implement shared mobile composition and route/title adapters, then the manual Proof slice, saved-original recovery, order/scan, evidence/history/shipment, and account/integrations. Retain existing domain and capture services. Each slice needs targeted tests and native evidence before the next release gate. No fixed schedule is claimed before device findings are resolved.
