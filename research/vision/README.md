# Experimental CPU vision worker

F01, F03, F04, F06 and F08 process actual immutable local media and write private source-linked artifacts. Physical identity, condition decisions, liveness and customer findings remain **unqualified and disabled**. Only server policy can bind a worker result to an authorized sealed Proof. The worker has no credentials, no network client, no capture owner, and no authority to finalize or change an original.

## Reproduce

Use Python 3.12 on Linux and an isolated environment:

```sh
python3 -m venv /tmp/packproof-vision
/tmp/packproof-vision/bin/pip install --require-hashes -r research/vision/requirements-linux-py312.lock
/tmp/packproof-vision/bin/python research/vision/doctor.py
/tmp/packproof-vision/bin/python -m unittest research.benchmarks.test_protocol research.benchmarks.test_canonical -v
/tmp/packproof-vision/bin/python research/benchmarks/run.py --output /tmp/packproof-vision-results --sparse3d
```

Install a controlled Tesseract build for OCR; the recorded experiment used Tesseract 5.3.4 with English language data. Missing Tesseract yields explicit unavailable OCR diagnostics while preserving other observations. No automatic model or language downloads occur. The hash lock targets Linux x86-64 CPython 3.12. Other platforms must create and review a matching wheel lock, not silently substitute dependencies. The simpler `requirements.txt` excludes optional COLMAP; `requirements-sfm.txt` includes it.

## Adapter contract

```sh
python research/vision/worker.py --job /private/job/job.json --output /private/job/output
```

Positional `worker.py job.json result.json` is also accepted. Successful execution returns exit 0; a bounded analysis failure writes FAILED / NOT_CHECKED and returns exit 2. Invalid outer job/output paths can fail before a result exists; callers must always enforce their own timeout and treat a missing result as failure. The backend adapter uses a 60-second outer deadline around the worker's 55-second deadline.

A job has `schemaVersion: packproof.vision-job.v1`, `analysisId`, `feature`, `sandboxRoot`, `binding` (tenant, Proof, sealed root, subject), immutable `sources`, and bounded `parameters`. Sources require `sourceId`, local `path`, lowercase SHA-256 (optional `sha256:` prefix), exact `byteLength`, and `mimeType` or `mediaType`. Preserve `objectVersionId` and `captureSessionId` when available. Binding metadata is echoed as attribution; the worker does not authenticate it. Jobs with client verdict/qualification/threshold overrides are rejected.

Only PNG, JPEG, WebP, PGM native luma sidecars, MP4/MOV, WebM and AVI containers are accepted. Container signatures are checked before a decoder runs. Media paths must be inside the private job sandbox, regular files, and not symlinks or URLs. Input bytes are copied while hashing into read-only private snapshots, then decoded from those exact snapshots. Finalized source originals are never modified. Snapshot lifetime ends with the process; the backend must also delete its job directory after artifact persistence or failure.

A result has `schemaVersion: packproof.vision-result.v1`, operational/finding states, observations with immutable source references and pixel/time coordinates, coverage/gaps, diagnostics, provenance, resource usage, and artifacts. Artifact paths are relative filenames within the output directory and include byte count, SHA-256, MIME type and source references. The backend must verify those hashes, paths, authorization and source-reference subsets before persisting the result in the shared `packproof.analysis.v1` envelope. Private OCR/text and source pixels require original-equivalent access controls and must go through ProofShield for external derivatives.

## Feature inputs and evidence limits

| Feature | Input parameters | Persisted processing | Remaining gate |
|---|---|---|---|
| ProofPrint | Exactly two distinct source IDs; `regions` with `regionId`, `group` (`label` or `carton`), polygon in stored source pixels, optional material | SIFT/RANSAC registration, original/registered crops, strong-content exclusion mask, bandpass and common-mode suppressed descriptors, texture/content diagnostic correlations; groups remain separate | Passive native region association and independent physical copy/transfer/cross-device qualification |
| ProofSight | Still/video; bounded `samplingHz` 0.5–8 | Tesseract exact readings, uncorrected text consensus, source-linked optical-flow tracks and losses, every sparse sampling gap | Package/item/action models and full continuity remain unqualified; image feature tracks have no physical object identity |
| ProofTwin 2D | Exactly two sources; `regions` containing attributed unchanged `support` polygons | Constrained homography, observed overlap mask, source overlays, support photometric noise and pixel-difference map | Repeated physical change/no-change controls, supported damage classes, metric noise floor |
| ProofTwin sparse3D | `mode: sparse3d`; 3–12 views; one `objectMasks` polygon per `(sourceId, frameIndex)`; optional declared `focalLengthPixels` | Real pinned CPU COLMAP feature extraction/matching/SfM; camera poses, sparse points, exact pixel tracks, fit errors, triangulation angles and exploratory RANSAC planes | Object-mask validity, stable package state and physical geometry study; metric scale remains UNKNOWN |
| ProofLive | Single timed video and server-validated `challenge` with ID and 4–32 gradual commands (`timeMs`, `level`); no subsecond command gaps | Time-aligned measured luminance, spatial-tile correlations, planar/epipolar motion diagnostics and raw response measurements | Freshness is verified by backend; emitted light/optical timing, safety and every replay family require physical lab studies |
| ProofPilot | Image/video | Sharpness, bright/dark clipping, dynamic range, detail selections and retained beginning/middle/end context | Device-specific blur/glare calibration and native control integration; worker never operates a camera |

ProofPrint and 2D comparison choose the sharpest available decoded sample from each of exactly two distinct input sources. A single video cannot impersonate two shipment legs. Regions refer to the selected source coordinate frame, so enrolled sidecars with stable region annotations are the preferred comparison input. Native integration must bind those coordinates to the actual selected frame. The worker does not infer transaction relationships from images.

## Fixed resource policy

128 MiB total source bytes, 24 million decoded pixels per image, 1,600-pixel maximum analysis edge (explicitly recorded), 120 samples total, 120-second maximum clip, 24 sources, 16 annotated regions, 16 MiB artifacts, 1 MiB result JSON, one native CPU thread, 2 GiB virtual address-space ceiling, Linux CPU/file-descriptor/file-size limits, and a 55-second wall deadline. COLMAP adds 3–12 views and a 35-second mapper budget. Expensive jobs fail operationally; they never emit a discrepancy. Initial image metadata is inspected before pixel decode; video dimensions and duration are checked before sequential decoding. Optional work cannot affect recording because workers run only after commit.

These process limits are defense in depth, not a substitute for OS isolation of native decoders. Run the backend worker process in a nonprivileged network-disabled container with a read-only application filesystem, a private per-job writable mount, and no cloud credentials. The development CLI is local-only but does not create Linux namespaces. Do not mount unrelated tenant files into its job sandbox. No deployment is created by this branch.

## Research status

`research/benchmarks/reports/synthetic-cpu-2026-10-02.json` records reproducible local engineering measurements. Generated fixture media are kept out of source control. The synthetic cuboid is intentionally marked synthetic and cannot meet device, package, attack, measurement or safety qualification. Frozen policy `policy.json` never allows consistency/physical-difference/liveness promotion, even on an identical-image comparison. Camera facts, physical trials and operator approvals are not invented to close these gates.

The baseline intentionally does not emit untrained closure/packing actions, infer hidden package faces, identify products from labels, equate a rendered surface with a measurement, or treat detector confidence as a probability of authenticity. Sources retained for review are at least as important as selected diagnostic frames.

## Passive enrollment and locked baselines

`proofprint` with `parameters: {"mode":"enroll"}` proposes regions without manually annotated polygons. Localization uses a single white quadrilateral with observed OCR text, a separate enclosing quadrilateral, and kraft-color support outside the label. Multiple/no plausible labels or cartons, unreadable text, absent separated substrate patches and poor quality yield unavailable candidates. This intentionally narrow, unqualified proposal method does not infer that a loose label was actually attached. It prefers the last third of video while retaining wider beginning/middle/end context. It never asks the seller for a close-up or new step.

The enrollment artifact freezes the required label/carton groups, selected source frame, actual source-pixel crops, masks, descriptors, context links and unavailable reasons. Material crops and descriptors use **original decoded source pixels**; only geometry localization/registration is downscaled. The original source recording remains preserved and source frame coordinates disclose all scaling. No super-resolution is used.

The authenticated backend exposes POST/GET `/proofs/:id/rnd/enrollments` using `evidenceIds` and optional `supersedesEnrollmentId`. Migration 082 stores immutable versions and signed append-only state events: CANDIDATE → SOURCES_COMMITTED → ANALYZED → UNAVAILABLE → LOCKED. Every current profile is UNAVAILABLE for physical findings, even if four useful region candidates were extracted. New media/methods require a linked new enrollment. Database triggers prevent changing source inventory, required groups and prior events.

For comparison, supplying the locked `enrollmentId` binds the exact source version and selected frame on the server and loads its frozen regions. The server ignores any attempt to replace those regions with a favorable subset. A baseline without usable associated regions remains unavailable. Direct two-source diagnostic jobs are permitted for research but do not stand in for a locked qualified enrollment.

## Task-specific event research

`action_model.py` provides a reproducible compact temporal HOG + linear softmax training/evaluation harness for source-linked annotated three-frame windows. It verifies local source hashes and split lineage, requires purpose-specific training-consent confirmation, uses an explicit JSON model (no pickle), and exports optimizer details, tune-set confusion/predictions and model lineage. All predictions stay INCONCLUSIVE and all models stay unqualified. There are no shipped pretrained packing-action weights or claimed event precision.

```sh
python research/vision/action_model.py train --manifest /private/annotations/manifest.json --output /private/models/candidate-v1.json
python research/vision/action_model.py evaluate --manifest /private/annotations/test-manifest.json --model /private/models/candidate-v1.json --model-sha256 <exact-sha256> --output /private/evaluations/candidate-v1.json
```

Each record uses the benchmark manifest lineage fields plus three `frames` (`path`, `sha256`, increasing `timeMs`) and `annotation` (`event`, `ambiguous:false`, `annotatorId`). Ambiguous cases belong in a separately scored abstention population, not silently relabeled training truth. The same physical/source lineage cannot appear in training and independent evaluation under another record ID. Collecting consenting physical annotations, validating action classes and obtaining required high precision are open dependencies. Synthetic fitting tests establish only executable plumbing.

Native PGM luma sidecars retain `CONCURRENT_SIDECAR` relationship and their signed frame-reference timing association. They are not pixel-identical to later decoded video. Quality and explicit-region texture analysis can use luma; the unqualified kraft-color automatic enrollment method correctly abstains without chromatic source information.

### Optional event model and region-mask integration

ProofSight accepts an optional **server-configured** pinned model release. The backend materializes that verified JSON file inside the per-job sandbox and supplies `trustedModels.proofsight` (`path`, SHA-256, release ID). No client parameter selects a model path, digest or executable. The worker checks the exact file hash, feature, schema, method and disabled qualification/customer-display policy, then runs numeric inference over three consecutive committed video samples. It emits source-linked ACTION_MODEL_CANDIDATE observations with explicitly uncalibrated candidate scores. Sparse gaps remain; neither a confident candidate nor a mask can establish full continuity. No pretrained packing model is bundled.

Source-attributed parcel/item masks use `parameters.annotations`: up to 24 records with `annotationId`, `sourceId`, `frameIndex`, `semanticClass` (PARCEL, ITEM, HAND, OCCLUDER, OPENING, SEAM, OTHER), and a source-pixel polygon. The backend inserts the authenticated annotation actor; the worker emits HUMAN_SUPPLIED_ANNOTATION and an exact mask image, preserving that attribution. User annotations never become machine-detected physical identities.

An executable controlled-scene baseline uses `parameters.segmentation: {"mode":"STATIC_BACKGROUND_DIAGNOSTIC","backgroundSourceId":"<committed-still>"}` with an independently committed background still and later same-size views. Pixel differencing and morphology produce source-linked foreground masks and boxes. Camera motion, lighting and hands remain explicit failure modes; automatic masks are labeled UNASSOCIATED_FOREGROUND. The synthetic mask test exercises the real component without pretending that foreground is a particular parcel or product. Learned automatic parcel/item masking still needs a consented labeled corpus and qualified profile.

ProofMatch can also invoke the same bounded worker for channel `appearance`: actual color-histogram intersection/correlation and constrained registered-luma correlation. These broad appearance measurements are independent of the authorization/fusion service and never assert physical-instance identity. Source annotations, masks, model scores and image resemblance cannot be voted into a trust score.
