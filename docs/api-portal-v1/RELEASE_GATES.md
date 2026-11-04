# API and records portal release gates

This checklist implements sections 12–14 of the November 3, 2026 plan. Proposed
targets remain planning targets until measured. A demonstration, controlled pilot
and general availability have different evidence requirements. Record the exact
candidate commit and intended environment on every result.

## Source and deployment boundary

1. Reconcile the existing API/worker/client source, deployed immutable images,
   readiness, enabled flags/cohorts, current database migration checksums/roles,
   Cognito identity, bucket versions/protection, secrets owners and current backup
   recovery point. Do not publish secret values.
2. Pass source-bound CI, authorization/contract checks, migration/compatibility
   checks, relevant full product builds and deployment-tool validation. Include
   skipped checks with reasons; a skipped PostgreSQL test is not a pass.
3. Rehearse additive migrations on a representative restored copy. Deploy a
   compatibility bridge first when the old runtime rejects future ledger IDs.
   Keep a tested rollback image compatible with the new schema. Preserve Proof
   IDs, manifest bytes, grants, accepted work and client identity.
4. Use the existing exact-source backend release workflow and reviewed canary
   process. Record image digest, task definition, migration/runtime-role receipt,
   configuration equality, source identity and terminal rollout state. Never use
   a mutable image tag or the legacy infrastructure deploy as a shortcut.
5. Publish the website from its exact pushed source, retain its existing Site ID
   and audience, and record the saved version plus successful deployment. Current
   Site source can differ from GitHub main; reconcile before overwriting it.
6. Recheck signed-in user/partner/employee flows against the released artifacts.
   Public `/ready` success alone does not prove these flows.

## Required risk-based matrix

| Scenario | Pass condition | Smallest credible evidence |
| --- | --- | --- |
| Lost response after commit | Same key returns the durable prior result, without a second record. | Domain + PostgreSQL transaction/concurrency integration. |
| Different payload with reused key | Conflict; original outcome remains unchanged. | Command contract test. |
| Duplicate/out-of-order source event | One scoped business update; source/receipt times retained. | Adapter fixtures + actual source reconciliation. |
| Queue dispatch or worker crash | Accepted receipt remains visible and safely resumes after lease expiry. | Durable-work integration/fault injection. |
| Wrong tenant/location/environment | No leak through IDs, queries, counts, suggestions, media, logs or exports. | Negative authorization integration. |
| Revocation during work/export | Current authority checked before release; denied/limited result. | Real streaming and queued-job authorization. |
| Corrupt/missing artifact | Verification fails with the named artifact; no silent replacement. | Independent offline verifier against complete real export. |
| Stale/rotated/untrusted signing key | Explicit trust result; historical verification material remains available. | Signer/trust tests + key-rotation exercise. |
| Connection permission/schema failure | Cursor/mapping/history retained; understandable action and safe recovery. | Supported provider test account, actual reconnect/replay. |
| CSV leading zeros/time zone/invalid row/retry | Actual preview, original-file receipt, distinct row outcomes and no duplicates. | Parser/domain + hosted novice workflow. |
| Held deletion and fresh restore | Held data retained; deletion and revocation decisions reapplied before access. | Isolated backup/object/policy restoration. |
| Search failure/lag | Error/freshness visible; authorized direct record remains usable. | Portal/API integration. |
| Upgrade and rollback | Existing clients still work; accepted data and pending jobs survive. | Staged compatibility rehearsal with representative records. |

## Controlled pilot acceptance

Select one authorized site, one named source owner, a defined shipment workflow
and a bounded historical sample. Include ordinary shipments, split/partial cases,
missing evidence, conflicting references and a supported return. Record the source
artifacts actually available. Samples must remain visibly labeled and isolated.

- Compare paired manual and PackProof evidence assembly tasks with equivalent
  evidence. Report median/distribution, sample size, assistance and failures; the
  proposed improvement hypothesis is at least 50% lower median time.
- Identify a named maintainer, supported provider edition/scopes/objects, cadence,
  backfill cap, reconnection path and escalation route for the first connector.
  A generic webhook endpoint does not meet nontechnical connector acceptance.
- Verify operators distinguish missing evidence, adverse observations and failed
  integrity. A hash/signature pass must not be understood as proof of condition.
- Obtain product, engineering and pilot-owner acceptance of the actual evidence.
  No pilot invitations or provider approvals are implied by writing this checklist.

## Usability and accessibility gates

| Task | Proposed acceptance target | Measurement requirement |
| --- | --- | --- |
| Sample record | Median <=5 minutes | Start at opening setup; explicitly labeled sample. |
| Supported connection | >=80% unaided within 15 minutes active setup | At least 10 representative nontechnical participants; report provider waits and total elapsed time. |
| CSV import/ordinary mapping correction | >=90% unaided within 10 minutes | Keep invalid rows, timeouts, assistance and abandoned attempts in results. |
| Find known shipment | >=90% within 30 seconds | Realistic dataset; order/tracking/shipment/customer reference. |
| Locate supporting evidence | >=90% within 60 seconds | Correct event and source supporting a concrete question. |
| Explain status | >=90% distinguish missing/adverse/integrity failure | Ask what a passed file check proves. |
| Keyboard/assistive review | Essential flows complete | Both themes, visible focus, headings, tables/dialogs, screen reader, zoom, reduced motion and mobile layout. |

A five-person formative round can reveal issues; it does not establish the plan's
percentage claims. Requiring a terminal, API key, JSON editing or database console
for an eligible supported customer path fails the nontechnical setup gate.

## Performance, cost and recovery gates

Run a permission-scoped benchmark with 100,000 records, 20 observations and 10
artifacts per record; include a large record with 500 handling units and 1,000
observations. Burst at least 10x the agreed pilot rate. Use realistic media sizes
and hardware/network; retain p50/p95/p99, errors, CPU/RSS, queue age and SQL plans.

| Measure | Proposed target | Status until measured |
| --- | --- | --- |
| Metadata availability | 99.9% per calendar month | Unknown; eligible service failures/timeouts/capacity denials count. |
| Metadata response | p95 <=500 ms, p99 <=1.5 s | Unknown; exclude transfer/provider wait only where defined. |
| Accepted event to visible record | p95 <=10 s, p99 <=60 s | Unknown; measure durable receipt to authorized projection. |
| First webhook attempt | p95 <=30 s | Unknown; measure committed event to initial attempt. |
| Ordinary image processing | p95 <=60 s after upload completion | Unknown; publish bounded fixture set and separate queue/processing. |
| Scoped record search | p95 <=1 s | Unknown at benchmark shape. |
| First useful portal view | p75 <=2.5 s after authentication | Unknown on agreed midrange device/network. |
| Disaster recovery | RPO <=15 min, RTO <=4 h | Unknown until named scenario and complete safe restoration are timed. |

Measure cost per accepted record and retained GB, including background polling,
originals/derivatives, processing, logs, repeated exports, downloads, backups and
retention. Set accepted workload limits before advertising capacity or pricing.
Verify actual backup retention/latest recovery point and perform the fresh-target
drill in [OPERATIONS.md](OPERATIONS.md). A database backup setting is not a restore
result; historical synthetic restoration is not a current production RTO.

## General availability decision

- [ ] Published routes, schemas, events, SDK examples and limits match exact source.
- [ ] Every accepted command has a durable result, recovery path or actionable state.
- [ ] One supported production connector passes setup, capability and recovery checks.
- [ ] Nontechnical setup and recovery meet measured usability targets.
- [ ] All scoped access surfaces and queued/streamed revocations pass.
- [ ] A recipient independently verifies the exact portable package and detects alteration.
- [ ] Retention, holds, deletion, backup and safe restoration agree with customer policy.
- [ ] Critical security/integrity findings resolved; residual risks have a named owner.
- [ ] Performance, cost, monitoring, support ownership and runbooks are validated.
- [ ] Migration and compatible rollback rehearsed using existing clients and records.
- [ ] Proposed 14 consecutive days at pilot workload meet agreed service objectives,
      without unresolved severity-one integrity/access incident.
- [ ] Product, engineering and pilot owner accept a source-bound release receipt.

Stop expansion for integrity/access/accepted-work loss. Prefer scoped feature or
connection admission controls while preserving accepted records and pending jobs.
Roll back routing/application/worker versions only to a compatible artifact;
never delete evidence, undo revocation or reset migrations to obtain a green gate.

## Release receipt template

Record candidate commit; source repository/Site version; environment; API/worker
image and task identity; migration/privilege comparison; configuration-preservation
result; exact check commands/workflow links; browser/device/source datasets;
usability denominators and failures; load/cost/recovery measurements; pilot dates;
known limitations; rollback identity; accepting owners and acceptance time.
Record each external or unavailable gate as **not run**, with the exact missing
input, owner and next step. Never mark it passed from this checklist alone.
