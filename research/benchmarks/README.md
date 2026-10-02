# Research benchmark and dataset protocols

`run.py` executes real image/video processing on reproducibly generated synthetic fixtures. It exercises recapture, same-content copy, label transfer, missing carton, quality degradation, OCR/track gaps, 2D condition changes, safe laboratory response metadata and optional actual sparse COLMAP reconstruction. Results are measurements of code execution and synthetic images; there are zero physical, user or native-device trials. No threshold may be promoted from these fixtures.

```sh
python research/benchmarks/run.py --output /tmp/unique-benchmark-run --sparse3d
python -m unittest research.benchmarks.test_protocol research.benchmarks.test_canonical -v
python research/benchmarks/evaluate.py --manifest /private/corpus/manifest.json --config research/benchmarks/configs/physical-qualification-v1.json --trials /private/corpus/trials.json --feature F01 --output /private/reports/heldout.json
```

The experiment output contains each job, immutable input hashes, worker results, diagnostic crops/maps, sparse source-linked geometry, timing and memory. Aggregate synthetic measurements may be committed under `reports/`; private research corpus media must never be committed. Use private object storage with explicit consent, purpose, retention and access controls for real data. Copy report artifacts with their hashes into the authorized experiment record before temporary storage expires.

## Freeze and split before evaluation

`configs/physical-qualification-v1.json` contains proposed population, supported-scope and per-family error requirements. Hash its exact bytes before inspecting a held-out test set and put the resulting lowercase SHA-256 in `manifest.frozenPolicyDigest`. Threshold or method changes require a new immutable version and a fresh held-out test set. Do not tune to this synthetic benchmark and report that as physical accuracy.

A private manifest uses `dataOrigin` (`physical-consented` or `synthetic`), `frozenPolicyDigest` and `records`. Every record needs `recordId`, `split` (train/tune/test), `physicalInstanceId`, `captureSessionId`, `sourceDigest`, `deviceId`, `materialLot`, `attackFamily` and, for evaluation, `experimentUnitId`. Include `printRunId`, `cartonId`, `labelId`, `printerUnitId` and `attackDeviceId` where applicable. Keep provenance/consent/ground-truth documents in a separately access-controlled manifest. IDs must not contain addresses, customer names or other unnecessary personal data.

The validator rejects reused physical specimens, capture sessions, source digests, print runs, cartons and labels across splits. Frozen independent device/material/printer/attack-device partitions are also checked. A deliberately held-out device study may need a separate experiment manifest from a same-device repeatability study; do not silently remove holdout constraints to make an existing corpus pass. `same-content-reprint`, `photographed-print`, `screen-replay`, `label-transfer`, `carton-patch-transfer`, `wrong-template`, `probing`, and `malicious-baseline` are separate F01 families. Results cannot merge label and carton evidence or count a transferred genuine label as package-level success.

A trials file has `attempts`, each naming an exact `recordId`, its declared `independentUnitId` (must equal the record's experiment unit), `attackFamily` and `outcome`: ERROR, CORRECT, ABSTAIN or EXCLUDED. Include `repeatableBypasses` rather than burying a practical failure in aggregate metrics. Count all eligible acquisitions, failed captures and exclusions in separate coverage/genuine-error ledgers; an error bound alone is insufficient for a gate.

For dependent pair trials, the evaluator collapses attempts by the prespecified independent unit and family and marks a unit erroneous if any attempt is erroneous. It computes a one-sided exact Clopper–Pearson bound on evaluated units. At 95% confidence, zero errors need at least **29,956 independent units** for a 0.01% upper bound. Ten thousand pairs from one carton still count as one unit. Genuine independence must be designed and audited; software cannot create it by relabeling rows.

`evaluate.py` rejects policy-digest mismatch, split leakage, non-test rows and attempt-lineage mismatch. Reports identify missing attack families and remain `qualified: false` / `releaseAuthorized: false`. Statistics cannot grant scientific, safety or release approval.

## Annotation scope

Record exact source SHA-256, decoder build, frame index/time, polygon, visible parcel association, annotator, ambiguity and disagreement. Use LABEL_VISIBLE, IDENTIFIER_OBSERVED, ITEM_TRACK_STARTED, ITEM_VISIBILITY_LOST, CONTAINER_VISIBLE, ITEM_CROSSES_OPENING, CLOSURE_ACTION_VISIBLE, SEAM_VISIBLE, RECORDING_INTERRUPTED and POSSIBLE_REOPENING only when the visible evidence supports the named event. Distinguish observed action from the identity of the product or completeness of closure. A task-specific label/action model is not yet qualified in the baseline.

Keep every inter-sample gap, occlusion, similar-object ambiguity, parcel exit, interruption and off-camera closure. Reused optical-flow feature IDs do not bridge custody. Native interruptions must come from committed capture journals; a sparse image worker must not invent a recording-stop event. Double-label a held-out subset without model predictions, resolve disagreement separately, and score each enabled class at its frozen time tolerance. No full continuity conclusion is available from this worker.

Physical studies still required: ordinary uncoached packing captures versus coached optical bench captures; S24 Ultra↔A16 plus independent Android/iPhone combinations; 240 labels/60 cartons as a screening cohort, printing technology/unit/media lot strata; real copies/transfers and optical replay; measured unchanged/changed cartons and shadow/reflective controls; safe authorized replay/injection studies; and blinded reviewer tasks with and without enrichment. These are dependencies, not claimed accomplishments.

The exact Stage A allocation from the October 1 reference is supplied as `configs/physical-corpus-240-60-v1.json` with a SHA-256 sidecar: four print technologies × three media lots × two identical-content designs × ten physical copies = 240 planned labels; 60 planned carton surfaces across three classes with new/reused examples. Multiple printer-unit allocations, S24 Ultra/A16 directions, independent phone families, modes, source lineage, physical attacks, handling cases and required ablations are explicit. All collection counts are zero and source hashes are null. It is a frozen acquisition **template**, not an invented dataset. `create_corpus_template.py` reproduces it byte-for-byte. Populate a separate consented corpus manifest when actual acquisition occurs, preserving the template version and deviations.
