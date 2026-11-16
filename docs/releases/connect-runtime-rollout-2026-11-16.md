# Connect runtime rollout — November 16, 2026

**Status: hosted API/browser publication verified; the user’s installed Windows setup is blocked.** Candidate runtime admission, native API deployment, API/worker ECS convergence and public browser byte verification passed. At approximately 19:49 UTC, the user reported a generic service/protected-storage readiness failure after installing the unsigned Connect 0.2.1 candidate. Its cause is under investigation; this report does not qualify the installed Windows product or the overall release. This is a redacted release report, not customer or Windows 11 acceptance evidence.

## Source and artifact identity

| Item | Recorded identity |
| --- | --- |
| Application source | `debf53231d6f3ce8990afa74fbc47defac4f4ecb` |
| Connect desktop candidate | `0.2.1` — unsigned development/internal candidate |
| Release-operator source | `819769e` — canonical comparison of the observed empty ECS `systemControls` default |
| API/worker release version | `connect-v2-2026.11.16-debf5323` |
| Candidate image digest | `sha256:1aba206f8eaade4798c0dd277b5d0acea895cc69e19eb2960fbeeaddc5e84e82` |
| Verified Git source archive SHA-256 | `46ff9e13ea497afe0e2c844a596d933a9c1677db8fc46fd42ee676836c151ab4` |
| Source and applied database inventory | 108 receipts; SHA-256 `a873b3f50dc1d4a380067d4a3d1a642472827df2fb2e99634ac3b45aa6260a6d` |

The root-layout application archive contains 874 verified Git blobs, including the backend, shared evidence contracts and required research configuration. Source bytes were verified independently before upload. The existing unversioned source bucket uses a content-addressed object and conditional creation; the build re-fetches and checks its SHA-256 before unpacking. Application source is independent of the later release-operator commit. No application rebuild is implied by an operator-only correction.

The named `packproof-v2-staging-api` and its database serve production. Their resource names do not establish a separate staging environment. The prior November 8 restored rehearsal database is no longer present. This release uses source-bound candidate-image probes under the existing production runtime logins; those probes do not establish an isolated hosted end-to-end journey.

## Actual runtime admission evidence

Both one-shot probes used the candidate image, the exact generated and registered task definition, existing separate runtime credentials and IAM roles, and the explicitly reviewed existing cluster/network. Probe code runs in a read-only database transaction and does not start the application or its background workers. Temporary task definitions retain their observed original secret references and runtime settings; sensitive bindings are excluded from this report.

| Probe | Actual task ID | Registered probe definition | Completion (UTC) | Observed result |
| --- | --- | --- | --- | --- |
| API login | `470b62332e6f41ea94a2c08d366255a4` | `packproof-connect-probe-debf53231d6f-api:1` | November 16, 19:29:01.329 | STOPPED; main exit 0; exact candidate digest |
| Worker login | `c5e4ab89716f46d5be38fd35dd278bcb` | `packproof-connect-probe-debf53231d6f-worker:1` | November 16, 19:29:07.468 | STOPPED; main and initializer exit 0; both exact candidate digest |

Each actual-login probe confirmed TLS 1.3, separate non-owner identity, the exact source and applied 108-receipt inventory, existing records and M2 privilege policies, no widened runtime authority, matching durability policy, and compiled CSV v2 guards. The existing runtime durability setting remains unchanged; a matching policy check does not claim a newly enabled durability profile. These results qualify candidate runtime admission, not authenticated tenant enrollment, browser permission decisions or a completed shipment import.

The private release plan was prepared at 19:31:37.078 UTC. Its reviewed topology digest is `2d379c60e541ac74fb32e94449f0121fb3765ea3333c51bee4dd5059461b0801`; its configuration lease is `d8ae90f3670f6b71bbe329c825e81ebc78b7a53839e8178259cd58cc33e2b815`. Freshness checks and exact predecessor comparisons must pass again at each promotion boundary; the timestamps in this report must not be used to refresh an expired observation.

## Promotion sequence and current status

The former API image is `sha256:3b1c81642b27a14629a5a8c8f4af4b0bf91f09bc0e0b5591e06af10d5bde0557`, source `3bff0173c9d91fc11ae614d72872b877628c327d`, task definition revision 55. The former worker image is `sha256:dbaabad53ecba284ba830ab5443242234ad28b95a28d5ac9ecc2bda834366fd2`, source `e6709d6cfb7634ec295133387d72d4920e5d1c8b`, worker task definition revision 5. Actual ECS state determines the current revision; the older CloudFormation task-revision output is not used as a deployment predecessor.

1. **Worker promotion — converged.** The existing worker service was updated to `packproof-records-production-worker:6` at 19:34:18 UTC. At 19:37:07.884 UTC, actual ECS state showed one PRIMARY/COMPLETED deployment, desired/running count 1 and pending count 0. Task `b63461e1fcfc409791f9b5115c949679` was RUNNING and HEALTHY; its main and initializer used the exact candidate digest, with the initializer STOPPED at exit 0. Post-deployment job/receipt health remains a separate check. The existing initializer, user, commands, dependencies, empty-host ephemeral volume, mounts, roles, secret references, network and desired count are preserved; both owned image references move together.
2. **API promotion — converged.** After verified worker convergence and fresh API/Express/topology lease checks, the guarded UpdateExpressGatewayService request was submitted at 19:37:25.136995 UTC. The new service revision is `3045000585326755207`, task definition revision 56. The orchestrator observed a new task RUNNING with the candidate digest, while the native deployment remained IN_PROGRESS and the former revision-55 task was still present. By 19:42:48 UTC, the public API reported the exact candidate identity and health checks passed, as recorded below. At 19:46:12.786837 UTC, native deployment `3045000585326755207` was SUCCESSFUL. Only the revision-56 API task was RUNNING, with the candidate digest; no predecessor API task remained RUNNING. At that same observation, the service still listed the predecessor revision-55 deployment as DRAINING with running count 0 and the revision-56 PRIMARY deployment as IN_PROGRESS with running count 1. At 19:47:33.416867 UTC, a fresh actual control-plane observation confirmed native SUCCESSFUL, API revision 56 PRIMARY/COMPLETED with desired/running count 1 and pending count 0, worker revision 6 PRIMARY/COMPLETED with desired/running count 1 and pending count 0, and no failures. The predecessor deployment had cleared. Both service revisions use the exact candidate image; worker health and successful initializer were verified separately as recorded above. Only the image and three release-identity values may change.
3. **Browser publication — public bytes verified.** The matching application-source web bundle has index SHA-256 `f7c75c9be08796b7b8a2a4d586f283f0a3ba88d93b54b9ec44953b22fe527b72` and release-manifest SHA-256 `15d52945ce4cac13be3d2ee0d1884915897a95eeda58079b56c2e1ec936e293a`. Both mutable pointers were conditionally written against their observed predecessor state, then independently fetched and byte/hash verified at the S3 origin. The previous hosted browser release before this publication was source `8e694d3bdce56a9211c77084cf67a7169ea683d4`. CloudFront invalidation `I9XFH52QXQY098NZ44JWBEDIY4` started at 19:47:51.907 UTC. The invalidation was Completed at the 19:48:24.895361 UTC observation. Public verification at 19:49:01.981095 UTC confirmed the expected application commit, exact index hash, all 52 declared asset hashes, and three route-shell responses (`/`, enrollment approval locator and installation approval locator). Each route returned the expected candidate shell bytes. The verifier also confirmed the linked production API’s exact candidate source, image and release version. These unauthenticated route-delivery checks do not establish successful login return or a real administrator permission decision.

### Public API and cleanup observations

At 19:42:48.271829 UTC, public HTTPS checks returned the following; a fresh observation at 19:45:47 UTC again confirmed the same source, image, health/readiness, CORS and unauthorized-denial outcomes:

| Check | Observed result |
| --- | --- |
| `/meta` | HTTP 200; production; source `debf53231d6f3ce8990afa74fbc47defac4f4ecb`; image `sha256:1aba206f8eaade4798c0dd277b5d0acea895cc69e19eb2960fbeeaddc5e84e82`; version `connect-v2-2026.11.16-debf5323` |
| `/health` | HTTP 200; `ok` |
| `/ready` | HTTP 200; `ready` |
| Unauthenticated `/me/records/agent-installations` | HTTP 401; `UNAUTHENTICATED` |
| Website CORS | Exact requested origins `https://dvpmnwc27i8tw.cloudfront.net` and `https://thepackproof.com` returned on the corresponding checks |

Both temporary probe tasks had already stopped. Their task definitions were deregistered at 19:42:43.882625 UTC. This cleanup does not affect the deployed API/worker definitions. At 19:43:17 UTC, the orchestrator reported that the current worker task's available log events contained startup with no error event; that observation does not establish a processed receipt, successful job cycle or full ingestion journey.

Final ECS service steady-state and public browser asset/route-shell verification are recorded above. Current worker job/receipt health remains distinct from service health. The installed Windows failure and authenticated shipping journey remain unresolved; published bytes alone do not close them.

## Preservation and rollback

This is an image-only application update over the existing database and services. It introduces no DDL, role grants, secret rotation, endpoint change, source activation, queue reset, deletion or reinterpretation of pending originals. Both predecessor images were retained under the existing ECR policy before the single candidate push.

If rollback is required, inspect current state first because ECS may already have rolled back. Pause affected CSV v2 sources and reconcile accepted work without removing originals or receipts. Restore the exact predecessor API primary container before restoring the worker revision. Worker rollback requires fresh read-only evidence of zero active v2 sources and zero pending v2 imports, plus confirmation that the exact former API configuration is stable. Do not relax semantic validation, roll back schema or delete protected work to force compatibility.

## User-installed Windows failure — investigation open

At approximately 19:49 UTC on November 16, the user reported a generic service/protected-storage readiness failure after installing the supplied unsigned development Connect 0.2.1 executable on their Windows setup. The exact failing guard, service lifecycle condition and protected-storage state are not yet established. The issue is being investigated in the Windows service/installer and PowerShell lifecycle paths.

The successful Windows Server candidate and matching hosted API/browser release do not prove that the application works on this user’s Windows 11 installation. No successful first setup, first canonical Proof, second unattended export, repair or protected-work continuity is claimed for that machine. Do not label the installer fixed or request a destructive reset based on these hosted results.

## Acceptance still open

The installed Windows 11 clean-install/upgrade/restart checks, authenticated source configuration → whole-original upload → separate exact batch approval → canonical Proof retrieval → separate recurring approval, second unattended export, offline/revocation checks, installed scaling/screen-reader acceptance, five-person usability observation and signed production distribution remain separate gates. The personal unsigned development installer may be provided under its existing authorization; its availability does not close those gates.

Private execution artifacts retain the full observed baseline, source/build review, exact registered probe configurations and stopped-task results, runtime plan, worker update request, successful worker convergence observation, API update request/receipt and matching web preparation receipts. Credentials, complete environments, secret references, source report contents and presigned URLs are intentionally omitted here. Hosted publication has been verified at the specific boundaries above. The reported installed readiness failure must be resolved and the authenticated installed-product acceptance completed before qualifying the overall release.
