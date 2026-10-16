# Phase 1 change manifest

Paths below are relative to `mobile/`. The preflight records the root-cause analysis; the review README records test results and remaining native acceptance. These are source changes and automated evidence, not a declaration that each device scenario passes.

| Task | Changed source | Before → after / rationale |
| --- | --- | --- |
| F1.01 | `src/experience/action-routing.ts`, `src/ui/ProofRecord.tsx`, `src/ui/EmptyState.tsx` | Ordinary finalized access emitted an error → normal detail navigation with read-only explanation. Nested banner flex could shrink text → wrapping text with a non-shrinking banner container. Real errors remain visible. |
| F1.02 | `src/experience/home-adapter.ts`, `src/experience/proof-detail-model.ts`, `src/screens/MyProofsScreen.tsx` | Generic/dropped workflow hints and repeated list text → retain the server's next action and supporting hint, show identical status/action once. |
| F1.03 | No capture semantics changed | Existing partial-photo, receipt reconciliation, response-loss and replay behavior checked through recovery tests; device reproduction is still required. |
| F1.04 | `src/app/PackProofProvider.tsx`, `src/experience/proof-request.ts`, `src/experience/action-routing.ts` | Late reads could replace the latest selection → generation/account checks throughout reads and persistence, matching Proof/transaction/manifest IDs, atomic publication and workspace cancellation. |
| F1.05 | No native recording semantics changed | Existing capture-navigation lock, explicit Back choices and interruption journal inspected; provider navigation regression coverage updated. Device calls, permission loss and force-stop remain unverified. |
| F1.06 | No upload or retention semantics changed | Existing original-retention and receipt-dependent progression verified through recovery suites; native offline/relaunch acceptance remains unverified. |
| F1.07 | `src/notifications/NotificationBridge.tsx`, `src/notifications/destination.ts` | Initial-notification callbacks could outlive their account effect → cancel stale callbacks and require exact account/Proof identities. |
| F1.08 | `src/copy/chronology.ts`, `src/experience/proof-detail-model.ts`, `src/ui/ProofRecordTimeline.tsx` | Participant join assumed Buyer and actor lookup allowed related-entity fallback → neutral defaults, exact matching audit event and historical role metadata. Evidence commit copy no longer assumes video. |
| F1.09 | `src/ui/ProofEvidencePreview.tsx` | Loading lacked explicit presentation → image/video loading, ready and failure feedback with retry. Authorized original-content/package paths remain in use. |
| F1.10 | `src/ui/ProofRecord.tsx` | Biometric verification was overstated → signing-key signature verification and client-reported device-authentication limitation are stated separately. |

## Tests and delivery

- `tests/final-refinement.test.ts`: finalized navigation, authoritative task copy, role provenance, mismatched identities, latest-request routing, removed membership and notification identity.
- `tests/proof-request-provider.test.ts`: executes the provider functions for delayed A versus B, cancellation during native account persistence and sign-out races.
- `tests/capture-navigation.test.ts`, `tests/proof-entry.test.ts`, `tests/recovery-workspace.test.ts`, `tests/task-home.test.ts`: existing contract regressions adjusted to the corrected state/copy behavior.
- `package.json`: `test:final-refinement` entry point.
- `.github/workflows/android-refinement-review.yml` at repository root: exact-source internal APK, contract checks, artifact receipt and logs; explicit platform-tools package avoids the setup action's obsolete default.
- `docs/android-final-refinement-2026-10-16/` at repository root: preflight, task status, actual test logs, change manifest and native review worksheet.

No API, schema, canonical manifest, evidence retention, production data or primary-navigation changes are included. The PR remains a Phase 1 draft pending the plan's native review gate.
