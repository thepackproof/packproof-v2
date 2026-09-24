# Admin dashboard release — September 24, 2026

The final API is source `147ecc73e1ae5663c96337df8afd0c60887e5c79`, image
`sha256:ecbce8061bb86d88b338395c0b32486836f48391494013639ccf306cd316fc24`,
task-definition revision 35. Its rollout reached native `SUCCESSFUL` at
11:20:37.372 UTC with 100% production traffic. Required API release gates passed.

The original candidate reached formal `SUCCESSFUL` at 10:42:41.870 UTC; the old bridge stopped
at 10:48:50 UTC, IAM isolation completed at 10:49:38 UTC, and website v33 was
published at 10:50:20.306833 UTC. Real Cognito user-session checks and a live
customer capture/upload flow were **NOT EXERCISED**; no user bearer tokens were
available. This receipt distinguishes those limits from completed deployment
checks.

The routing-patch evidence below supersedes the original API as the current
release. Website v33 remains live unchanged.

## Reviewed artifacts

All backend images use the existing staging ECR repository in account
`784514617543`, region `us-east-1`. Shared `latest` tags were not used for these
release identities.

| Artifact | Source commit | Immutable image digest / bundle hash |
| --- | --- | --- |
| Compatibility bridge | `ed5986dd17aafe33d4e9efa318673722ee52e749` | `sha256:98d02b55bf9b0664f4713b18f46abc32f2f3cdcf71b16d111207fcf5cf71d543` |
| Previous API / preferred rollback, revision 34 | `8cd278ba457de1961e722dee54d7e84b162c2962` | `sha256:e64749d8f5179befc45c4d96371f795a9a753bb9db28c13f592f0e364be10beb` |
| Current API, revision 35 | `147ecc73e1ae5663c96337df8afd0c60887e5c79` | `sha256:ecbce8061bb86d88b338395c0b32486836f48391494013639ccf306cd316fc24` |
| Operator bundle | `6e9cf67a43f5462257fab77fc35cc3f8248dcdcf` | `0237e75757a1a4bd8884b12b714be60e54a209d87a9167a3a5da9a1019318f58` |
| Website v33, published | `14ffdddf8211dde41341f78b6fe830f16f457571` | Archive SHA-256 `5228ade601989b20052051362767745509f7e355d02c9faf14fbe8a09dd7b4c0` |

The original API's local equivalent commit was
`078c140e419835736b8f78987594468ef4631361`; both original API commits have tree
`5a9ac188562e140a4af180be605ab922fc387d91`. The image reports the remote source
commit in the table. The operator source is separate from the API image source.

| Build | CodeBuild ID | Result |
| --- | --- | --- |
| Bridge, build 82 | `packproof-v2-staging-api:cca65242-3562-4efb-95dc-7b69076eec54` | Succeeded |
| Candidate, build 83 | `packproof-v2-staging-api:0d6aecc1-c010-48b3-9333-b5c015b66812` | Succeeded |
| Routing patch, build 84 | Build number 84 | Succeeded |

## Final routing patch — deployed

The patch uses an own-property check for admin section dispatch so inherited
object-property names cannot be treated as valid section handlers. It makes no
other backend runtime changes. Four invalid-name cases and a valid-section
regression are covered; the admin-read suite passed all 14 tests and TypeScript
checking passed.

The remote source is `147ecc73e1ae5663c96337df8afd0c60887e5c79`; its local
equivalent is `01aa532d74c2c901efb2bf3a419c37eba81bf065`, with shared tree
`3df0642e9e03a0c82432c72a4e3bfb011276efe5`. CodeBuild 84 succeeded from a
1,295,693-byte source ZIP with SHA-256
`d0831ec81dcd2c2fab224e6839b2ffa522ff460c8b93897b7342441ee1b7439f`.
Required CI run `35990173076` completed successfully at 11:10:30 UTC on the exact
remote patch SHA: all ten jobs passed, including backend, real PostgreSQL,
secret scanning, deployment scripts, and Android. Infrastructure run
`35990172879` and CodeQL run `35990172877` also succeeded on that SHA.
Independent iOS run `35990173041` was compiling at 11:20:15 UTC with no failed
steps; it is not a server rollout gate. The earlier `30052b47bb9f` revision passed
iOS for the same application code, with only secret-scan configuration differing.

Read-only verifier task `ccec5bdc99194063b43392120d0fe16c` emitted a passing
result at 11:03:11 UTC for the exact patch source, complete 74-migration schema,
runtime roles, and internal authorization guards. This ran **before traffic
shift and after the owner-secret IAM deny**. The process exited 0 at
11:03:11.530 UTC; ECS confirmed `STOPPED` at 11:03:34.809 UTC.
Worker observations describe the existing service, not patch-worker execution.
The reviewed rollout request changes only the image and three release-identity
environment values; all other configuration matches the approved predecessor,
with unique environment/secret names. The accepted update at 11:11:51 UTC reached
native `SUCCESSFUL` at 11:20:37.372 UTC: 100% production traffic, one running
target task, zero pending, no triggered alarms, and no circuit-breaker failures.
All ten preservation checks passed. Revision 34 had zero traffic and zero running
tasks in the native service-revision view. At the 11:22:06 UTC observation its
actual task remained `DEACTIVATING` in the normal 300-second deregistration drain,
and legacy `DescribeServices` still showed `PRIMARY/IN_PROGRESS`. This receipt
does not claim that task had stopped. Both API revisions use the same non-owner
credential boundary; this drain does not reopen owner authority or negate the
completed native rollout.

Public checks at 11:18:14 UTC, during the 100% traffic bake before formal
completion, returned the exact patch source/image from `/meta`, HTTP 200 from
`/ready` and `/health`, and HTTP 401 from unauthenticated `/admin/overview` and
`/me/capabilities`. Every response had the expected custom-origin CORS. A separate
final IAM policy readback and per-resource simulation, observed at 11:22:06 UTC,
reconfirmed the exact runtime secret was allowed and the owner secret explicitly
denied. No secret values were read.

## Observed database results

The initial database had 69 migration receipts through 068, 155 public tables
owned by `packproof`, and no separate runtime role. The reviewed historical
inventory digest was
`32fa80605167a89551dc07712849b90d699020d74a620269ff11770be64cf747`.

| Operator task | Mode | Final result (UTC) |
| --- | --- | --- |
| `44490778295e4313b1205624a6be7040` | Migration inspect | Exit 0, 10:26:11 |
| `aa85c113090d4f8a98e9d6df693bf477` | Migration apply | Exit 0, 10:29:05 |
| `29d78a5ec5cb42d1b955b9251307fbe2` | Runtime credentials inspect | Exit 0, 10:31:05 |
| `ac282124d07849c4b88c88159baf5f50` | Runtime credentials apply | Exit 0, 10:33:10 |
| `6dce230da5a4408ca85c527261a49fa1` | Administrator bootstrap | Exit 0, 10:45:03 |
| `f983d2bf97a6424eac2d6169a72cfc74` | Candidate runtime verifier | Process exit 0, 10:46:06; ECS stopped 10:46:29 |

Migration apply verified exactly the five hashes in the
[runbook](../ADMIN_DEPLOYMENT_RUNBOOK.md#pinned-migration-bytes), each with
`EXECUTED_BYTES` provenance; the complete inventory now contains 74 migrations.
The temporary migration login was removed before the verified receipt. All eight
new tables are owned by `packproof`: `user_system_roles`,
`system_admin_audit_events`, `admin_command_receipts`, `system_feature_flags`,
`billing_allowance_adjustments`, `public_analytics_daily`, `admin_error_triage`,
and `client_version_activity`. Actual database TLS remained TLS 1.3 and the
durability-required flag remained false. The operator-attested recovery point
for the apply task was `2026-09-24T10:22:28.000Z`. Bridge `/ready` returned HTTP
200 after migration at 10:29:17 UTC.

Runtime credential setup created `packproof_app_runtime_v1`. A fresh connection
authenticated as that login, with the same `current_user`, using the separately
injected new credentials. It checked effective privileges across all 163 public
tables, 285 protected column privilege combinations, and six sequences. The
login has exactly the `packproof_runtime` and `packproof_recovery` memberships,
without membership-administration rights, owner membership, or permission to
assume the owner. Its connection used TLS 1.3. The ownership preflight found 63
public functions, all owned by `packproof`, and zero security-definer functions.

All ten transactional negative probes were denied: administrator role assignment,
audit modification, migration receipt modification, reopening recovery,
altering policy mode, table creation, disabling triggers, audit truncation,
granting owner authority, and assuming the owner role. Probe transactions were
rolled back. The runtime credential operator did not perform service cutover or
administrator assignment. A later, separate bootstrap task emitted
`system_admin_bootstrap` with `role: SYSTEM_ADMIN` and `alreadyAssigned: false`,
then exited 0. The committed implementation grants the role and appends the
bootstrap audit event in one transaction; this success receipt therefore
evidences both operations. Identity values are kept out of this receipt.

| Verified pin | SHA-256 |
| --- | --- |
| Complete 74-migration inventory | `bdf67730e4b82223593005cfbe7c1317e04d5654175193bc9bb49bb622531d53` |
| Runtime privilege SQL | `3f5f31605c4c6bc6312fde306008ca28ca15d9679d5ee45c099406118313f47c` |
| Runtime credential operator | `01a34331b758ee0f1bd1b861e7dcfed634484bc10529b926e009f49876dbb1ec` |

The protected operator records retain the exact ECS exit states, CloudWatch
receipts, checksum comparisons, and public readiness response. This document
does not contain credentials, signed URLs, full task configurations, personal
identity values, or account cost values.

## Runtime, IAM, and publication evidence

The read-only verifier used the candidate image and a fresh
`packproof_app_runtime_v1` connection through native ECS credential injection.
It passed the complete schema, ownership, and ACL checks: 1,141 table privilege
combinations, 285 column checks, and 18 sequence checks; no owner authority,
elevated role attributes, temporary migration roles, or security-definer
functions were found. Internal guards allowed the bootstrapped administrator
and denied an ordinary user with `ADMIN_FORBIDDEN`/403. This was an internal
guard check, not a real Cognito HTTP session. The rotating secret callback was
not exercised by this verifier.

The verifier ran at 10:46:06 UTC while the old bridge was draining. Its worker
snapshot covered ten groups with zero error instances, but included 19 retained
stale instances and mixed old/candidate attribution; it does not establish
candidate-only worker execution. AWS telemetry returned 11 available and nine
unavailable metrics. The missing results reflected absent datapoints, unaligned
rate inputs, or unconfigured CloudFront, rather than a task-wide telemetry IAM
failure. Cost data was available and the configured alarms were healthy; cost
amounts and utilization are not asserted as service-health proof.

After the bridge task stopped with exit 0, IAM policy readback and simulation
confirmed the exact runtime secret was allowed and the owner secret explicitly
denied, both before and after removal of a duplicate application policy. This
was verified at 10:49:38 UTC, separately from the earlier runtime verifier. The
execution role was unchanged and no secret value was read by this check.
Subsequent `/ready`, `/health`, and `/meta` requests returned HTTP 200 with the
candidate source/image and expected website CORS.

Website publication succeeded for deployment
`appgdep_6ab500635b2481919b372aead5507baa`, version
`appgprj_6a9c2365007c8191a0958c54e4a67b95~appgver_5dfbc8cfe3a881918acfac5b16a55422`.
The native published URL is
[packproof-experience.packproof.chatgpt.site](https://packproof-experience.packproof.chatgpt.site),
with the existing custom domain [thepackproof.com](https://thepackproof.com).

## Completed gates, coverage, and rollback

| Gate | Current evidence |
| --- | --- |
| Compatibility bridge | Completed rollout; public identity/readiness checked |
| Database migrations | Applied and verified; temporary login removed |
| Runtime credential preparation | Applied; fresh login and privilege checks passed |
| Original API rollout | Formal `SUCCESSFUL` at 10:42:41.870 UTC; retained as preferred rollback |
| Final routing patch | Build 84, required API CI, verifier exit 0, and native `SUCCESSFUL` at 11:20:37.372 UTC |
| Final API public checks and IAM boundary | Exact source/image, 200 readiness/health, 401 unauthenticated checks, expected CORS, runtime allow/owner explicit deny |
| Old-task termination and owner-secret IAM isolation | Bridge stopped exit 0 before verified IAM cutover |
| Candidate runtime identity, privileges, and internal guards | Verifier exit 0; timing and credential-path limits above |
| Administrator bootstrap and audit | Atomic grant/audit success receipt and exit 0 confirmed |
| Worker observations | Ten groups, zero error instances; mixed/stale attribution disclosed |
| Frontend publication | v33 published successfully; authenticated navigation not exercised |

Live validation coverage is distinct from the required deployment gates:

| Check | Coverage |
| --- | --- |
| Real Cognito admin and ordinary-user HTTP sessions | **NOT EXERCISED** — no user bearer tokens available |
| Live customer capture/upload/recovery flow | **NOT EXERCISED** — no user bearer tokens available |

These live flows are not claimed as passed. They do not add deployment blockers
after the required runtime/internal authorization guards and other release gates
have passed. Existing source, unit, integration, and CI evidence keeps its original
scope; it is not presented as a live Cognito session or customer capture.

The preferred routing-patch rollback is the original API source and image
recorded above, with task-definition revision 34's
non-owner credentials and the current IAM deny/configuration preserved. For a
wider backend rollback, the compatibility bridge remains available with those
same runtime credentials, grants, and credential-access restrictions; do not
restore its original owner-credential task configuration. All additive migrations
and immutable data remain. Verify readiness under the retained runtime identity.
The pre-bridge image is not a valid post-migration rollback target.
