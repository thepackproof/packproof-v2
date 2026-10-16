# Experience restoration implementation checkpoint

The October 16 restoration plan is **not fully implemented or release ready**. This branch completes source discovery, a reviewable design candidate and independent capture-feedback safety work. The candidate is deliberately isolated from production navigation and theme selection while the plan's G1 visual-direction review is pending.

## Baseline and authority

- Repository: `thepackproof/packproof-v2`.
- Frozen source: `80b83b10a0f2d8c2dc30f7c2eb642e3b4979b0b4`, tree `b23dc674d245c7eab452478bf994c6b750d051a6`.
- Baseline commit records Android 69 production submission and web 60. Installed-binary equivalence was not checked.
- Branch: `feature/experience-restoration-2026-10-16`.
- Governing requirements: Experience and Visual Identity Restoration Master Plan, October 16, version 1.0; root `AGENTS.md`; core invariants in `docs/DEVELOPMENT_PLAN.md` and `docs/architecture.md`.
- Source was recovered through the connected GitHub API because terminal DNS was unavailable. Changed blobs, all trees and the signed baseline commit were verified against Git object hashes before checkout. The baseline working tree was clean.

The founder authorized execution. The attached plan separately requires a decision on the actual proposed visual direction at G1 (pages 16 and 33), physical-device and formative testing at G2, fresh-user acceptance at G3, and named-build release review at G4. No unobserved review, test or approval is recorded as completed.

## Concrete work delivered

1. [Source, state and feature map](DISCOVERY.md), including the ordinary-sale versus grading distinction and exact existing command owners.
2. Seven interactive design scenarios: first opening, item photos, recording review, upload, recovery, saved record and evidence tools. Light/charcoal, 100/130/200% text and reduced motion are selectable. The standalone output embeds the existing licensed Inter font, approved logo, sample recording and an authentic historical repository screenshot; it needs no network connection.
3. Explicit demonstration events distinguish local acceptance, bytes transferred, artifact acknowledgment, workflow-step acceptance and finalization. Wrong-Proof events are ignored. The ordinary example does not invent a photo requirement. The current seller declaration is imported from its source file by the builder.
4. A production-code fix silences haptics throughout the native recording promise, including barcode and unrelated button feedback. Pending feedback cannot replay if recording started while its system checks were waiting. This gate never writes evidence or domain state. Native scan feedback also responds to a changed reduced-motion setting.
5. Executable tests and CI wiring. Results below distinguish real source regression checks from demonstration-only checks.

## Review and reproduction

Build the standalone review from the repository root:

```sh
node docs/experience-restoration-2026-10-16/prototype/build.mjs /absolute/output/PackProof_Experience_Restoration_Review.html
```

Open the resulting HTML in a browser. Use the seven scenario controls. In Upload, advance the explicit demo events one at a time: transferred bytes, artifact acknowledgment, finalization acknowledgment. In Item photos, accepting the back photo completes local capture; saving the files still waits for a separate item-step acknowledgment. These controls do not call a server.

Run source tests with the repository's installed dependencies:

```sh
npm --prefix mobile run test:experience-restoration
node --test docs/experience-restoration-2026-10-16/prototype/contrast.test.mjs
node docs/experience-restoration-2026-10-16/prototype/dom-check.cjs /absolute/output/PackProof_Experience_Restoration_Review.html
npm --prefix mobile run typecheck
```

The DOM checks use the existing Web `jsdom` dependency. No dependency or lockfile upgrade is introduced.

## Verification actually completed

| Check | Result | Evidence and limits |
| --- | --- | --- |
| Native source regression set | 73 passed | `verification/native-regression.txt`; includes 6 new capture-feedback tests, real recorder start callback, navigation, current Proof projection, upload handoff, photo drafts, capture recovery and final refinement. Camera hardware is mocked. |
| Prototype lifecycle fixtures | 14 passed | Demonstration state model only; not native integration acceptance. |
| Candidate token contrast | 21 passed | Normal-text and control-boundary calculations from the actual review CSS. Does not prove rendered WCAG conformance. |
| Prototype DOM interactions | 11 passed | `verification/prototype-dom.txt`; all seven scenarios, photo/task distinction, declaration, save acknowledgments, resume identity, offline recovery, wrong-Proof callback, exit guard, packet notes and variant controls. |
| Mobile TypeScript | 803 source/declaration files, 0 errors | `verification/typecheck.txt`. Existing local installed dependencies were resolved through temporary compiler path overrides because dependency links were unavailable; no production tsconfig was changed. Standard clean-install CI remains the independent check. |
| Browser rendering / actual media decoding | **Not run** | Browser runtime could not start: required Windows platform directory missing, HRESULT `0x80070003`. DOM checks do not provide screenshots or layout measurements. |
| Physical Android / iOS | **Not run** | Android device bridge failed to start; no accessible physical iOS device. No device recordings, TalkBack results or frame-time claims. |
| Fresh-user usability | **Not run** | No formative five-person cohort or fresh ten-person acceptance cohort supplied. |

## Gate and work-package status

| Work | Status |
| --- | --- |
| WP01 baseline/route inventory | Source complete; installed-build and physical reproduction evidence pending. |
| WP02 state/policy map | Source complete; live test-account contract checks pending. |
| WP03 reference/tokens | Historical repository reference recovered; exact original Zite reference unverified. Candidate neutral palette and existing Inter type ready for review. |
| WP04 prototype | Working standalone candidate and automated interaction checks complete; visual inspection and founder G1 decision pending. |
| WP05–10 production adapter, UI, journey, tools and compatibility | Broad migration not started before G1. Independent recording-feedback fix is implemented. |
| WP11 accessibility/performance | Candidate contrast calculations and source typecheck complete. Native, rendered-layout, assistive-technology and performance evidence pending. |
| WP12 usability | Protocol prepared in the supplied plan; both cohorts pending. |
| WP13 platform propagation | Pending stable approved Android contracts; no cross-platform completion claim. |
| WP14 release/rollout | Pending prior gates; no production deployment, store submission, version bump or merged release. |

## The G1 decision

Review the proposed neutral paper/charcoal surfaces, blue action and green saved-state accents, existing Inter typography, Capture/Record/Tools structure, and event-driven feedback. Approving this concrete candidate unlocks the genuine Android vertical slice; it does not establish native correctness or usability. Any requested visual correction belongs in this isolated candidate before application-wide propagation.

Next slice: derive a shared presentation adapter over the existing recovery, photo-draft and full-Proof contracts; compose the approved task/evidence/status primitives around existing command owners; connect one real transaction through its template's required capture, declaration, save and reopen journey. Preserve all routes in the map. Then obtain physical-device and formative evidence before the full migration.

## Rollback and data compatibility

This checkpoint introduces no migration, new stored preference, queue schema, backend endpoint or evidence write. The review is standalone. The feedback gate exists only in process memory and its cleanup is scoped to the recorder promise. A presentation rollback therefore does not require touching originals or journals. This is a source compatibility assessment, **not a completed old/new binary rollback rehearsal**. Run the attached plan's full draft/queue/committed/shared/expired-record matrix after the actual vertical slice exists.
