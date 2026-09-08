# Local media concurrency observation — 7 September 2026

The implemented mixed workload passed the **local** W03 memory check against the existing deployment's **1,024 MiB** memory target. The acceptance threshold was 70%, or **716.8 MiB**; this target came from `infra/api-service.yaml`, not from a value chosen after measurement.

| Observation | Measured result |
| --- | --- |
| API and all child processes, peak sampled RSS | **304.4 MiB** |
| Conservative sum of concurrent process high-water marks | **318.3 MiB**, 31.08% of the configured target |
| Sampling | 1,923 samples, nominally every 20 ms; zero invalid API samples |
| Maximum observed child processes at once | 4 |
| Ten authenticated HTTP playbacks | All completed; 100,000,000 bytes each, about 40 seconds |
| Two native recording commits | Both committed identical verified source digests; 2.24 and 2.34 seconds |
| Two recipient exports | Both ready; four selected source frames each; 8.50 and 8.42 seconds |
| Unexpected process exits during load | 0 |
| Total source bytes read during load | 2,200,000,000; largest source chunk 65,536 bytes |
| Separate interrupted export recovery | Real claimed worker interrupted after load; replacement produced READY on attempt 2 |

The source fixture is a generated H.264 MP4: 1280×720, 30 frames per second, 39 seconds, exactly 100,000,000 bytes. The encoder produced 97,258,979 bytes; a valid MP4 `free` box supplied the remaining 2,741,021 bytes. It contains synthetic test patterns, no customer recording or shipment. Its SHA-256 is `332b03b53d60444ec9f1cc7f1f7c20a07ae55a3e90db5edb520a83ddc8509b58`.

The separate W03-B check requested bytes 1,048,576–2,097,151. It returned HTTP-domain status 206 and read **exactly 1,048,576 bytes from storage** in chunks no larger than 65,536 bytes. API RSS increased by 73,728 bytes between its before/after samples. Returning this range did not read the other 98,951,424 bytes. The ten concurrent playbacks exercise the actual Express HTTP route and stream backpressure; clients consume at 2,500,000 bytes per second each, matching the fixture's 20 Mbit/s encoding rate.

The two commits use real capture registration, streamed staging, exact-version preservation, full-file hashing, bounded ffprobe validation, and transactional evidence/journal commits. The exports use actual scoped case creation, durable export queue records and `processRecipientExport`, selecting four offsets (1, 9, 18 and 30 seconds). Each export spools and verifies the original once per selected frame, invokes the existing limited ffmpeg renderer, and produces a five-page Stripe-format PDF. No whole-original `ObjectStore.get` call is permitted by the harness.

After the measured workload finished, the harness queued a third export, waited for its real `RENDERING` lease and renderer startup, and deliberately sent SIGKILL to that worker's process group. A replacement API worker retained the database and object store. Its fixture clock advanced eleven minutes past the existing ten-minute lease; it reclaimed the job through the normal export worker and completed on attempt 2 with cleared lease fields. This deliberate fault injection happened **outside** the measured load interval and is reported separately from unexpected load exits. No lease rows were rewritten to manufacture recovery.

## Reproduce

From the backend directory, using installed repository dependencies and a **new empty output directory**:

```bash
node --import tsx scripts/media-load.ts /tmp/packproof-media-load-new-run
```

Required local tools are ffmpeg, ffprobe, prlimit and the renderer's supported DejaVu font. The script generates the valid fixture, creates a separate PGlite database service, starts an API/media worker, runs the range and mixed workloads, performs the interrupted-export exercise, and writes `media-load-report.json`. Expect approximately one minute and enough temporary disk space for the fixture, three staging/preserved recordings, database and frame spools. Use a fresh directory for each run; persisted scenarios are reserved for the harness's own recovery phase.

The database service preserves transaction boundaries across IPC. It is intentionally outside the measured API process tree because the deployment uses external RDS. Its separately observed peak was approximately 461.4 MiB. API measurements include all live descendants, including ffmpeg, ffprobe, prlimit and TypeScript tooling where present. The observer resolves the outer process ID from `/proc/self/status` and reconstructs descendants from `Pid`/`PPid`; it works when namespace process IDs differ and the kernel omits `/proc/.../task/.../children`. A missing API RSS sample or failure to observe concurrent child processes prevents the gate from passing. Exit events are separately recorded even for short-lived parser/render processes. An observer fuse terminates the tested process group if sampled usage reaches the full 1 GiB target; it was not triggered.

The scripts pass a TypeScript check using the backend's strict NodeNext compiler settings. The [raw observation](media-load-observation-2026-09-07.json) includes the exact clean input commit and tree, unchanged launch/completion source checks, harness-file SHA-256 values, all job outcomes, sampled series, child exits, exact fixture probe, storage accounting and recovery result. Two earlier calibration runs were explicitly invalidated when PID-namespace and unavailable child-list interfaces prevented complete measurement; their memory values are not used in this result.

## Limits of this evidence

This was a local run from verified clean commit `73ef9b31a680f3d3a67fbd1eed5608cd98ea7692` (tree `e712f3c47d86fe6aea2e036dba0dfe34516228bc`), with filesystem storage and a separate PGlite process. The commit, tree, clean status and all three harness hashes were unchanged at launch and completion. It does not measure S3 latency, PostgreSQL concurrency, encryption/decryption infrastructure or production IAM. The host exposes a shared, read-only 20 GiB cgroup and an eight-CPU quota; the deployment target is one GiB and 0.25 vCPU. The harness compares measured process memory against the fixed deployment limit but cannot install that kernel memory or CPU limit here. Its nominal 20 ms samples can miss shorter peaks; concurrent process high-water marks provide an additional conservative measure, and child exits are recorded separately. This is process RSS evidence, not a measurement of production cgroup page-cache charging.

The valid measured run supports the implemented starting concurrency and queue-recovery behavior locally at the frozen source checkpoint. The release must still be run in the deployed container limits with the actual external services before claiming production capacity or closing operational acceptance.
