# CORE-01: repository and release audit

Audit date: 2026-10-02. Baseline: `a157356924bf4bf688e171c9ff223576fcb6ca3d`. Scope: source inspection only. No production account, deployed database, bucket, signing credential, live device, cloud job or distribution service was accessed. `AGENTS.md` and `docs/DEVELOPMENT_PLAN.md` were read first; their transaction/Proof, capture and immutable-finalization invariants remain binding.

## Existing components

| Component | Observed implementation | Extension boundary |
|---|---|---|
| Shared backend | Node/Express modular monolith in `backend/`; PostgreSQL runtime and PGlite tests | Add R&D routes/services and additive migrations; preserve existing Proof transitions |
| Evidence commitment | `backend/src/domain/evidence.ts`, resumable-upload and S3 adapters | Verify committed source identity/bytes; do not create an independent commit authority |
| Finalization | `backend/src/domain/finalize.ts`, `finalize-requirements.ts`, `canonical.ts` | Preserve existing canonical root bytes and requirements |
| Capture core | `backend/src/capture/`; mobile `src/capture/engine.ts`, journal/recovery modules; web capture queue; desktop evidence engine | Optional analysis consumes committed evidence and cannot block original capture/finalization |
| Android owner | Expo native module `packproof-unified-camera`; one CameraX binding with Recorder, preview, analysis | Extend its optional frame/event tap; do not create a second owner |
| iOS owner | Same native module; `AVCaptureVideoDataOutput` plus `AVAssetWriter` | Preserve writer/sample ownership and durable finalized markers |
| Existing attestation | `packproof-attestation` native biometric-authorized P-256 signatures | This is not already Play Integrity, App Attest or camera hardware attestation |
| Signing | Manifest signing, trust registry, local PEM and KMS runtime code already exists | Inventory trust context and avoid an unrelated parallel root-signing contract |
| Web/desktop | React/Vite web; Electron desktop with separate main-process evidence persistence | Shared observation/status/reviewer semantics; no native-phone assurance inherited |
| Export/privacy | Evidence review/export, disclosure and recipient-export routes already exist | Append access-scoped analysis inventory and derivative lineage; preserve the sealed source |
| Tenant/outbox | Existing `backend/src/platform/` tenant/auth/idempotency/outbox, existing worker patterns | Extend bounded durable queue patterns; avoid new brokers or microservice proliferation |
| Returns/custody | Existing commerce lifecycle, stages, custody and parcel scope | Add missing subject links, never duplicate the transaction root |
| Migration authority | Ordered SQL in `backend/migrations`, `backend/src/db/migrate.ts` | Additive schema; baseline highest numbered migration was 075 |

Locked versions are recorded in `baseline-source-inventory.json`. Existing source documentation includes historical scope descriptions; implementation and the enduring invariants govern extension decisions. The plan's proposed package paths are responsibilities to map into this code, not evidence those directories existed at baseline.

## Protected behavior and baseline evidence

The source inventory records SHA-256 and byte counts of canonicalization, commit, finalize, export, retention and capture/recovery owners from the baseline Git blob. Source hashes are not a substitute for actual canonical root/media regression fixtures. CORE-02 owns those fixtures and the executable baseline regression evidence separately.

Existing relevant test suites include `backend/tests/finalize-requirements.test.ts`, `evidence-capture-boundary.test.ts`, `upload-discard-recovery.test.ts`, `capture-completion-receipt.test.ts`, `retention-policy.test.ts`, and mobile/web capture-recovery tests. Their existence does not claim they passed in this audit.

## Release and credential audit

| Surface at baseline | Trigger/risk | Source safeguard added |
|---|---|---|
| Android AAB / Android recovery | Signed EAS builds; manual dispatch could choose arbitrary branch | No-secret preflight plus explicit research-branch job gate |
| iOS signed archive | Manual dispatch and EAS signing credentials | Same preflight before job secret allocation |
| iOS store assets | Signed build plus simulator with live API/auth defaults | Both jobs gated; research uses separate local tooling |
| iOS upload verified build | Manual App Store submission, main-only | Main condition retained and source policy added |
| iOS submit current release | `workflow_run` with pinned historical main SHA, automatic EAS submit | Original condition retained plus source-policy gate; absent policy on historical checkout fails closed |
| Desktop signed release | Manual signed/notarized builds and optional updater publication | Signing and publication both depend on source policy; original publication condition retained |
| Deploy staging | Manual job; main CI precondition; AWS credentials | CI gate and deployment gate also depend on source policy |
| Legacy desktop candidate / iOS simulator / Android camera spike / CI Android native build | Unsigned/debug artifacts but deployed endpoint or release-identity defaults | Existing candidate jobs gated on research source; ordinary source/unit tests remain available |
| Ordinary CI / infrastructure lint / CodeQL | Tests, static checks and artifact reports | Retained without cloud signing/deploy credentials |

All existing credential-bearing or publishing jobs are covered by `scripts/rnd-release-guard.test.mjs`. The reusable `.github/workflows/rnd-release-policy.yml` uses read-only contents permission, no secrets, no OIDC and checkout without persisted credentials. Its result must explicitly be `true`; missing/failed/skipped preflight cannot release. Repository variable `PACKPROOF_DISTRIBUTION_AUTHORIZED=true` alone cannot bypass the committed research marker. Non-main sources, research environment metadata, missing/malformed build policy, pull refs, and checked-out/event SHA mismatch deny distribution.

This is repository-level protection. Remote branch-protection settings, organization policies and old workflow files already deployed on `main` were not changed. No workflow was dispatched. The branch was not pushed or deployed by this audit.

## Retention observed in source

The current `retention.ts` sets minimum protection to 90 days with `automaticEvidenceDeletion: false` and no automatic expiry. `retention-policy.ts` includes draft review policies, holds, notice requirements and an explicit approved disposition gate; its candidate listing is dry run. Do not represent this as a deployed 90-day deletion policy, and do not shorten protection for R&D. Model/template/derivative/research retention needs purpose-specific policy and consent. No S3 Object Lock, legal hold or destructive lifecycle setting was changed.

## Foundation verification

`node scripts/rnd-release-guard.test.mjs`: seven tests passed for branch/marker/metadata denial, malformed configuration, source SHA mismatch, credential-job dependency guards and native candidate isolation. `node scripts/rnd-release-guard.mjs`: current source denied as research. Workflow YAML parsed successfully with local Python PyYAML. No actual GitHub Action, signing build or remote cloud gate was executed.
