# PackProof Logistics API deployment — verified state and release handoff (2026-11-21)

This is an **operational handoff**, not permission to bypass the release gates or a claim that the live API has been deployed.

## User-visible incident

The qualified unified Windows 0.7.0 build from `main` displays `PackProof request failed (404)` on its Logistics entry screen, immediately after sign-in. The desktop invokes `GET /me/records/agent-installations/{installationId}/workspace-access?organizationId=…&environment=…` in `desktop/src/main/api.ts`. That endpoint exists in `backend/src/records/setup-assistant-router.ts` at the qualified main source but did **not** exist in the API source currently deployed in AWS. An invalid/missing installation or an ineligible facility can independently produce 404; verify these after upgrading the API.

## Verified immutable source

- Reviewed source: `617a58b883328ad04513a48564d33c573b9b7c78`
- Main-branch CI + Windows build/clean-install/upgrade acceptance: https://github.com/thepackproof/packproof-v2/actions/runs/44836162283
- Source archive generated twice by pinned AWS CodeBuild from **Git blobs**, using `backend-source-archive.py SOURCE ARCHIVE logistics-v1`; content re-verified via `--verify`
- SHA-256: `ad0de3976803f245a07c10ce12b9567763c2b8c52f2640ec5c9f8c3fd064b5aa`
- 1,046 source Git blobs, 128 migration entries, migration-inventory SHA-256 `8ab67cf9cc721d6da4c28cef72fdcdaf2b08faaa86196d76acff0a4f95f97fcc`
- CodeBuild source-verification build: `packproof-v2-staging-api:fd213639-7c7e-429c-b454-f171f26a855c` — succeeded.
- Private staged archive (not a public URL):
  - Bucket: `packproof-v2-staging-build-784514617543`
  - Key: `security-release/617a58b883328ad04513a48564d33c573b9b7c78/ad0de3976803f245a07c10ce12b9567763c2b8c52f2640ec5c9f8c3fd064b5aa/backend.zip`
  - Object version: `7wiZppUW32QUB6EMW.yrCm4vsF.LH.hL`
  - Encrypted AES256; versioned object; 14-day current and noncurrent lifecycle expiration
  - Staging build: `packproof-v2-staging-api:269cebe2-023f-4455-b777-f24b4fdadec8` — succeeded.
- Build bucket versioning was enabled to meet the release process's version-pin requirement. Its existing 14-day lifecycle was extended with 14-day expiration for noncurrent versions.
- A temporary CodeBuild IAM policy permitted **only** `s3:PutObject` to this exact encrypted object. The policy `PackProofTemporaryLogisticsSourceStage20261121` was deleted after staging.

## Hosted application observed in AWS

- Account 784514617543; region `us-east-1`
- ECS service `packproof-v2-staging-cluster/packproof-v2-staging-api` (the name includes “staging” but this service handles the live PackProof environment).
- ECS API task definition at inspection: `packproof-v2-staging-cluster-packproof-v2-staging-api:62`; latest deployed image `784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api@sha256:0eb281d47f59d172b28273d6f64a211a7a5a808fae3f7bd715c409dc799de619`.
- ECR image tag binds to old commit `ea6d69f6e66e613431fe1d62ab9a12bc875b933f` (2026-11-18). Deployed old source has no `workspace-access` endpoint.
- API task flag `PACKPROOF_ORDER_WORKSPACE_ENABLED=true`. No `PACKPROOF_GUIDED_FACILITIES` or `PACKPROOF_SETUP_AI_FACILITIES` binding was found in the inspected API container.
- Existing ECR lifecycle retains 12 images; current code's `logistics-image-builds.mjs` validates retention of predecessor plus candidate/fallback.

## Required next steps; **NOT** yet performed

1. **Build images from the pinned staged object version**, using the source-controlled `prepareLogisticsImages` builder in `infra/backend-release/logistics-image-builds.mjs`, then independently inspect immutable candidate/fallback ECR digests, image labels and compatibility. The attempt to initiate the image-builder request was blocked by the assistant's execution-tool safety checks. Do not bypass that tool-level control.
2. **Read-only database and topology inspection**. Verify current owner role, PostgreSQL ledger and migration lineage, worker/API task definitions, deployment status, private DB recovery point and restricted source privileges. Do not infer schema state from source alone.
3. Follow `infra/backend-release/logistics-hosted-owner-requests.mjs` and `logistics-hosted-migration.mjs`: obtain exact review/inspection receipt, qualify fallback and candidate, rehearse transaction and **roll back rehearsal**, then apply migrations 125–129 with the owner role only after successful independent receipts. Preserve existing originals, Proofs, workers and required rollback paths.
4. Apply the qualified worker-first, API-second cutover with immutable images and source-bound metadata, keeping `PACKPROOF_ORDER_WORKSPACE_ENABLED` and guided/assistant feature activation under reviewed controls. Verify health, both running services and the exact endpoint, including signed-in authorization responses and facility isolation.
5. **Enable guided setup only for the specific approved organization, environment and location** using `PACKPROOF_GUIDED_FACILITIES=` with the exact `organizationId:environment:locationId` tuple. The facility tuple has **not** been established from the current screenshot. Never use `*` or turn on all facilities. The assistant-specific allowlist `PACKPROOF_SETUP_AI_FACILITIES` is distinct and should be enabled only if independently approved. An eligible/authorized facility must also satisfy record workspace roles.
6. Verify Windows 0.7.0 `choices()`, facility setup, an actual order/Proof and clean login, including 404 recovery, on the **same actual endpoint and account**. Signed installer publishing remains separate.

**Current status:** Reviewed source archived and staged; bucket versioned with lifecycle; temporary IAM permission removed. **No new backend ECR image, migration, feature enablement, worker/API deployment, or customer change has been made.**
