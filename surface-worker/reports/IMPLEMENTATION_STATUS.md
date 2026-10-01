# R&D baseline status — 2026-10-01

Implemented: bounded source decoding; original digest checks; source-pixel polygons; same-frame barcode→label-outline candidate discovery; separately scoped print/carton/context regions; unknown/ambiguous geometry abstention; broad illumination and nominal-layout suppression; process-specific experimental bandpasses; printer-axis nuisance suppression; ORB/RANSAC plus bounded local translation; masks independent of mismatch; private per-region diagnostics; track-aware nonredundancy; frozen multiregion coverage; deterministic private artifact strings/digests; hardcoded unqualified application outcome; isolated CLI limits; container recipe; hash-locked dependencies; dataset split/media checks; frozen scoring; separate truth join; scope/stratum metrics and ablations.

The automated regression suite passed all 19 tests in 4.020 seconds. It uses **synthetic plumbing fixtures only**. It checks actual CLI execution; identical replay results; missing required carton coverage; reduced client requirements; media substitution; parent traversal/symlinks; oversized predecode dimensions; malformed/nonfinite JSON; repeated image bytes; no upsampling of tiny source regions; profile qualification tampering; ambiguous geometry; image-based label-outline discovery; native-shaped context+barcode region augmentation; repeated tracks; split leakage; frozen scoring; synthetic exclusion from physical metrics; and zero-error all-abstention misuse.

The real scientific corpus has **0 labels, 0 cartons, 0 device captures and 0 physical trials**. The 240-label/60-carton screening manifest is a collection plan. No blind physical report, attack pass, supported camera profile, calibrated threshold, optical accuracy, passive success rate, shipping durability, or production cost is claimed.

`SYNTHETIC_BENCHMARK.json` records five actual same-fixture runs on the shared Linux x86_64 execution host (CPython 3.12.14, NumPy 2.2.6, OpenCV 4.11.0). Median wall time was approximately 0.649 seconds, nearest-rank p95 approximately 0.919 seconds, peak process RSS approximately 90.1 MiB, and both source images totaled 1,337,776 bytes. Repeated result digests were identical and every output was inconclusive. These repeats are **not independent physical trials or a representative production p95**. The host was shared with other build/test tasks; the JSON records exact executable/profile/runtime digests and samples. There is no cost estimate based on nonexistent cloud usage.

Known environment failure: OpenCV 4.13.0.92 installed but exited with SIGBUS on import in this runtime. The verified lock uses 4.11.0.86 instead. Dependency/runtime changes require a new freeze, qualification, and security scan. The Dockerfile is supplied but this worker's standalone container has not been built/run here; local CLI limits are tested, container network/cgroup isolation is a deployment integration gate.

Remaining real-world gates:

- Resolve detail and continuity on actual S24 Ultra/A16 streams in both directions, then independent phones/iPhones.
- Collect same-content physical reprints across printer units/lots and separate genuine transferred-label assembly controls.
- Verify material classification and field-of-view geometry; candidate carton polygons are currently unverified geometric proposals.
- Establish that residual signal follows material across viewpoints and devices, rather than print content, printer identity or sensor noise.
- Freeze calibrated profiles/thresholds with independent sampling and blind evaluation. Procedural blinding requires an independent custodian; separate JSON files alone do not enforce it.
- Measure capture failure/passive success, workload p95, full memory/CPU, shipping/aging/wear, attack families, complete cost and retention/reproducibility.
- Pin/scan and retain container image digest; use a no-network read-only worker runtime before processing untrusted production media.

No distribution submission or production rollout is part of this work. This baseline intentionally cannot emit customer-visible surface consistency or physical-difference conclusions.
