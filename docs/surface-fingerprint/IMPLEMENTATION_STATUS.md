# FP-01–16 implementation and acceptance status

This is an R&D source/build status map. A ticket whose physical acceptance evidence is missing is not complete under the original production definition of done. No physical trial, store submission or deployment is represented as performed here.

| Ticket | Delivered R&D work / file map | Acceptance still required |
| --- | --- | --- |
| FP-01 | Audited repository architecture, `backend/src/domain/`, object-store commitment, single native camera owner; additive `backend/src/surface/`, `surface-worker/`, existing Proof viewers | Live deployment/IAM/storage/queue audit and release-environment confirmation |
| FP-02 | Claim/threat matrix, explicit unsupported states, frozen proposed metrics and empty qualification registry in this directory | Independent product/security sign-off using actual findings |
| FP-03 | Optional native sampling within `mobile/modules/packproof-unified-camera/`; source timing and R&D controls | Physical S24 Ultra and A16 uninterrupted-recording evidence; memory/thermal/disk/lifecycle measurements |
| FP-04 | Dataset contract/check tooling in `surface-worker/`; blank physical-instance/capture/trial templates and collection protocol | Collect 240 labels, 60 cartons, verified ground truth and locked independent splits; no physical corpus delivered |
| FP-05 | Native diagnostic metadata and worker quality/geometry reporting; no qualified optical thresholds | Actual-stream optical report per device, both phone directions and unsupported configurations; passive vs coached comparison |
| FP-06 | CPU OpenCV registration, content suppression, residual/substrate descriptors and research outputs in `surface-worker/` | Same-content physical reprints, layout/printer ablations and blind cross-phone discriminability evidence |
| FP-07 | Typed region groups, bounded registration, frozen assembly coverage, explicit unqualified outcomes | Actual transferred-label and transplanted-patch tests; context signal remains experimental |
| FP-08 | Deliberately deferred; no learned or angular authenticity claims | Add only if frozen blind tests improve error/coverage/cost beyond the classical baseline |
| FP-09 | Additive migration `backend/migrations/076_surface_fingerprint_rd.sql`; authorized server commands; leased bounded jobs and immutable records | Runtime/load qualification; regression evidence must include tenant/package, conflict, duplicate and lease recovery |
| FP-10 | Separate committed sidecars, exact source digests, append-only extension/export path; independent `verifier/surface-verify.py` | Real interrupted upload/app termination recovery and retained-original replay at the stated retention interval |
| FP-11 | Request-digest intents, scoped source commitments, private worker artifacts, quotas and fail-closed R&D semantics | Play Integrity/App Attest integration and physical replay tests; production decoder sandbox and permission audit; complete unsuccessful-attempt monitoring |
| FP-12 | R&D review/export integration across existing mobile/web/desktop surfaces; no qualified finding badge | Physical recipient capture acceptance; reviewer comprehension and cross-surface device QA |
| FP-13 | iOS source adapter in existing AVFoundation owner | macOS/Xcode build when available and independent physical iPhone stream, lifecycle and timing qualification |
| FP-14 | Blind shipping/aging/domain-holdout/attack protocol and blank report record | Execute independent physical study; denominators, uncertainty, ablations and unresolved failures — all unestablished |
| FP-15 | Isolated local launcher, cost/performance schema and explicit opt-in pilot gates | Real consenting pilot, usability, repeated usage, cost report and independent go/no-go decision; no pilot started |
| FP-16 | Defaults off, hard unqualified result barrier, experimental build isolation, empty support registry, export verifier and rollback runbook | Actual qualified matrix, frozen validated policies, monitored runtime and rollback rehearsal; production rollout not authorized |

## Repository audit observations

The current backend is an Express/TypeScript modular monolith with PostgreSQL/PGlite adapters and S3/local object storage. `docs/architecture.md` establishes immutable finalized manifests and server-owned content-addressed evidence commitment. The surface implementation adds its own records/jobs/extensions; it does not add surface inference to the core finalization predicate or mutate `final_manifests`.

Android's existing `UnifiedCameraView.kt` owns Preview, VideoCapture and ImageAnalysis. iOS's existing `UnifiedCameraView.swift` owns one AVFoundation session and AVAssetWriter. Optional sampling extends these owners. Linux static inspection or a simulator cannot establish native optical performance or uninterrupted physical recording.

Web and desktop reuse the established Proof/API view. A browser/webcam still requires separate optical qualification. Human account access and API-tenant binding are resolved from server state; clients do not choose arbitrary tenant/package ownership or submit authoritative scores.

## Gate A remains closed

The architecture and plumbing can be exercised, but no evidence yet establishes that ordinary passive capture resolves persistent instance-specific detail across the intended phones. If actual print detail is inadequate but carton texture passes, narrow the future qualified scope. If neither provides information beyond ordinary images/barcode content, stop customer-facing fingerprint inference and retain only the reusable capture/evidence work.

## Verification evidence convention

Automated checks must say what they tested. Protocol fixtures, generated image fixtures, a successful typecheck and a successful native compile are separate evidence categories. None changes the empty support registry. The root implementation report records commands and actual outcomes; pending or unavailable toolchains must remain explicit.
