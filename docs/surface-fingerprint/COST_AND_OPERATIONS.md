# R&D measurement and rollback

## Cost/performance instrumentation

`templates/benchmark-attempts.csv` is a blank collection schema, not a cost report. Record attempts that fail, retry, abstain or produce unavailable capture. Store only IDs/digests in telemetry; never images, address text, templates, tokens or signed URLs.

| Field group | Units and interpretation |
| --- | --- |
| Identity | Build, profile, extractor/scorer/policy digest, attempt/job IDs, capture mode and outcome |
| Device | Native stream, device/OS/lens, peak incremental RSS bytes, feature-off baseline bytes |
| Work | Queue wait ms, decode/extract/compare ms, wall ms, CPU ms, retries, timeouts |
| Media | Selected original count/bytes, derivative bytes, uploaded/retried bytes, transferred bytes |
| Storage | Original/template/derivative byte-days, actual retention period, deleted/expired state |
| Requests | PUT/GET/HEAD/queue/DB operation counts, decoder/container invocations |
| Workflow | Extra required actions, added operator ms, dropped/interrupted frames, evidence loss |
| Prices | Region, currency, price source/date, CPU/memory/storage/request/transfer rates |

Compute incremental cost from measured resource quantities × dated rates. Include failed attempts, retries, failed enrollments, retained failed media and feature support incidents. Report base-video cost separately. Per-success cost is total feature cost / completed enrollment+comparison pairs; also report cost per attempt and per conclusive comparison. If the denominator is zero, report undefined, not $0.00.

The initial $0.01 target is a requirement, not a measurement or AWS quote. Do not allocate GPU capacity before a CPU baseline and demonstrated cost-adjusted gain. Record CPU model, core quota, RAM limit, runtime/dependency hashes, concurrency, warm/cold runs and p50/p95 latency. Small synthetic fixtures validate instrumentation only.

## Local/shadow run constraints

All feature flags default off. Enable collection, extraction and internal comparison independently only in the experimental environment. Customer-visible findings remain disabled. Build identifiers, environment/API endpoints, signing identity and app variant must make the R&D boundary visible. Store/production credentials are not needed for local regression or offline experiments.

Preserve the existing camera owner. On thermal, memory, disk or stream pressure shed optional sampling and record unavailable reason. Never delete ordinary video, reduce its disk reserve, block finalization on analysis or turn a failed worker into a mismatch. Retain original sidecars until server media commitment; later recovery is a subsequent receipt, never a retroactive root edit.

## Monitoring before any controlled pilot

Track feature-on capture interruptions/loss; optional sample drops by reason; enrollment unavailable; unsupported profile rate; coverage/abstention by scope; internal contradiction; queue age; active/stale leases; retries/timeouts; decode rejects; repeated probes; source expiration; export verification failures; byte growth and cost per success. Alerts must identify build/profile, not imply fraud.

Thresholds for automatic pause must be established from the actual shadow baseline. Any repeatable attack, root-integrity regression, foreign-tenant disclosure or feature-induced evidence loss disables affected analysis immediately.

## Kill switch and rollback rehearsal

1. Record incident ID, current build/config digests and affected profiles. Disable customer findings, internal comparison, extraction and optional collection in that order. In an urgent capture regression disable collection first. Keep ordinary recording and historical evidence reads operating.
2. Stop new worker leases and stop/replace the experimental worker. Let already committed transactions finish or expire safely. Operational failures remain retryable/error states. Do not overwrite persisted comparisons or templates.
3. Verify an ordinary feature-off Proof can record, commit, finalize, view and export. Compare the exact frozen manifest bytes/digest before and after rollback. Verify existing surface exports still report original scope, limitations and omissions.
4. Retain immutable records and additive tables. Do not down-migrate away evidence. Deploying an earlier client is not permission to delete sidecars that are still awaiting committed upload.
5. Record queue disposition, permissions, tested restore/read paths and operator timestamps. A correction/new method is a new linked analysis, never editing an old result.
6. Resume only after independent review of the cause, relevant regression evidence and renewed qualification for changed camera/OS/compression/decoder/extractor/policy configurations.

No rollback deployment or cloud exercise has been performed by these documents. `templates/rollback-rehearsal.json` starts `NOT_RUN`.
