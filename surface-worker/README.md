# Experimental surface worker

This executable implements a CPU research baseline and dataset harness. **Every shipped profile is unqualified. Every application comparison abstains.** Nothing here establishes that PackProof can identify a physical shipping label or carton, resist copying, or infer contents, closure, custody, or reopening. Actual cross-phone, same-content-reprint, transferred-label, shipping/aging, and attack trials remain to be collected.

## Run locally

The tested dependency lock covers Linux x86_64 with CPython 3.12. Python 3.12, NumPy 2.2.6, and OpenCV 4.11.0 are recorded in output. OpenCV 4.13.0.92's downloaded wheel crashed on import in this execution runtime; it was not used. Any dependency or capture-pipeline change requires a new frozen evaluation.

```sh
cd surface-worker
python3.12 -m venv .venv
.venv/bin/python -m pip install --require-hashes --only-binary=:all: -r requirements.lock
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m packproof_surface --input /job/job.json --output /job/result.json --media-root /job/media
```

The backend receives stdout JSON when `--output` is omitted. With `--output`, stdout is empty and the result is written atomically. Exit 2 is an operational input/media error with a bounded JSON message on stderr. Signals, timeouts, dependency/import failures, and nonzero exits are operational errors, never physical differences. JSON contains no wall-clock timestamp; the backend records actual analysis receipt time.

## Isolated runtime

Build context is this directory. **Building this container is not deployment.** Resolve/pin the base-image digest, scan the dependency image, and retain the built image digest before qualification. This task does not enable production workers.

```sh
docker build -t packproof-surface:rnd .
docker run --rm --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --pids-limit=32 --cpus=1 --memory=768m \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  -v "$PWD/job-input:/job:ro" -v "$PWD/job-output:/out:rw" \
  packproof-surface:rnd --input /job/job.json --output /out/result.json --media-root /job/media
```

Prepare writable output ownership for UID 10001. The caller also enforces a 35-second wall deadline and kills the entire job process/container on timeout. In-process Unix limits are 30 CPU seconds, 1.5 GiB address space, 16 MiB file output, and 64 open file descriptors. Those limits are defense in depth, **not a network or syscall sandbox**. A bare backend subprocess has no network-namespace isolation; research ingestion should use trusted local media or the no-network container. The backend supplies only minimum committed originals, no cloud credentials, and no shared writable media directory.

Only JPEG and 8-bit grayscale/RGB/RGBA PNG are accepted. Header dimensions and SHA-256 are checked before decoding. Limits: six originals, 16 MiB per original, 16 million pixels, 8,192 pixels per dimension, 24 total regions, 384-pixel processing patches, 2 MiB input JSON. Paths must be relative under a job-private root and cannot traverse parents or symlinks. Run with private read-only inputs to remove filesystem race opportunities. Do not use arbitrary upload paths or URL downloads in this worker.

## API contract

```json
{
  "schemaVersion": "surface-job/1",
  "jobId": "server-issued-id",
  "operation": "compare",
  "profileId": "research-paper-v1",
  "requestedScope": "assembly",
  "enrollment": {
    "captureProfileId": "unqualified-android-rear",
    "acquisition": "live",
    "sources": [{"sourceId": "committed-evidence-id", "mediaPath": "enrollment/frame.jpg", "sha256": "64 lowercase hex digits", "frameTimeMs": 1234}],
    "regions": [{"id": "print-1-frame-1", "sourceId": "committed-evidence-id", "group": "print", "polygon": [[10,10],[210,10],[210,210],[10,210]], "process": "inkjet", "trackId": "print-1"}],
    "requiredGroups": ["print", "carton", "context"],
    "hints": [{"sourceId": "committed-evidence-id", "barcodePolygon": [[10,10],[210,10],[210,210],[10,210]], "printProcess": "unknown", "association": "same_frame_expected_barcode"}]
  },
  "observation": {"captureProfileId": "unqualified-android-rear", "acquisition": "live", "sources": [], "regions": [], "requiredGroups": ["print", "carton", "context"]}
}
```

The example illustrates field shape; replace digests and both source lists with real committed originals. `extract` needs only enrollment. `compare` needs enrollment and observation. Up to six sources per capture. Source IDs refer to immutable server evidence commitments; the backend independently checks tenant, Proof, package, leg, actor, intent, object version, and source digest. The worker does not authenticate those business bindings. `frameTimeMs` is optional/null when unavailable. Acquisition may be `live`, `offline`, or `supplemental`; none currently qualifies optics or scene freshness.

Region polygons use four clockwise TL/TR/BR/BL vertices in **original unrotated source pixels**. Mobile must undo analysis orientation before supplying coordinates. Region IDs are unique in each capture. Repeated observations of the same region share `trackId`. Print processes are `inkjet`, `laser`, `thermal_transfer`, `direct_thermal`, `substrate`, or `unknown`. Unknown print processes abstain from printable-region coverage. Separate print and carton planes are registered separately. Native metadata, stage statements, and continuity events remain server evidence metadata rather than inferred image facts.

Hints optionally supply a known `labelPolygon`, a same-frame `barcodePolygon`, a `labelTrackId`, and association `same_frame_expected_barcode`, `bound` (lab-only declaration), or `ambiguous`. Barcode-only hints trigger a bounded contour search for an enclosing label quadrilateral. Missing or ambiguous geometry yields no invented carton pixels. Proposed regions are explicitly `proposed_unverified`: they can include another plane/material, and are not physically authenticated associations. Native exact expected-barcode selection is only transaction context. Additional proposals fill missing print/carton/context candidate groups. No reliable physical track means cross-frame candidate types count only once.

Output `surface-result/1` includes `status`, `qualification`, `scopeResults`, coverage of every frozen group, source digests, method/runtime/artifact inventory, per-region registration/quality diagnostics, and private templates. Scope states are `not_checked`, `unsupported`, or `inconclusive`; application consistency/difference states are deliberately unreachable. Profile changes cannot enable them. Editing the profile to add thresholds, set qualification, or allow findings is rejected. Frozen assembly requirements cannot be weakened through a client-supplied required-groups list.

Templates and numerical diagnostics are **private security-sensitive R&D data**. Do not expose descriptors, correlations, pixel mappings with addresses, canonical payload strings, or match-oracle feedback to public clients. Backend public projections retain only scoped status, safe coverage, method IDs, and limitations. Templates contain `canonicalJson` and `artifactSha256`; the outer result contains `artifactCanonicalJson` and `artifactSha256`. Verify the exact UTF-8 canonical strings, not a JavaScript reserialization of floating-point numbers. Hashing image bytes protects digital integrity; it is never surface identity.

## Baseline and limits

1. Validate original bytes; rectify bounded polygons without increasing initial sampled patch dimensions.
2. Remove broad illumination; estimate coarse layout; exclude nominal layout edges and flat clipped pixels before bandpass residual extraction. Remove row/column medians to suppress printer-axis streaks. Process-specific bandpass parameters are engineering hypotheses, not calibrated physical models.
3. Register each plane with ORB layout features and RANSAC homography; reject excessive perspective, corner motion, reflection, area change, inlier loss, or fit error. Refine with at most three pixels of translation using layout, never a residual-fitting nonrigid warp. Registration may interpolate dimensions solely for alignment; it cannot recover missing optical detail.
4. Intersect independent per-image quality/layout masks with geometric support. The mask is never derived from mismatching pixels. Compute private normalized residual and layout correlations. Preserve transformation recipes and all enrolled required-region outcomes.
5. Aggregate repeated views by per-track median/range. Do not multiply correlated frame probabilities. Coverage requires at least two separated print regions, two separated carton candidates, and context as frozen research starting points. Near-duplicate regions and untracked repeated frames do not count as independent support.
6. Abstain. No thresholds, calibrated likelihood, camera qualification, claimed physical discriminability, or confidence percentage exists.

No learned model, generic image embedding, invented fiber detail, generative restoration, synthetic super-resolution, calibrated glare estimate, or photometric authenticity claim is used. Nominal suppression is imperfect and remains vulnerable to residual graphic/printer/sensor signals. Geometry-only substrate proposals require material validation. The scientific gate is identical-content physical prints across phones plus independent substrate and transferred-label controls.

## Blinded corpus and evaluation

`dataset/manifest.empty.json` is honestly empty: zero physical samples. Its 240-label/60-carton quantities are collection targets. `dataset/README.md` defines collection fields, splits, truth separation, and commands. The harness verifies immutable media hashes, identity/domain split leakage, mandatory same-content negative pairs, frozen runtime/code/profile/threshold identities, explicit synthetic flags, and completed prediction digests before truth joins. It reports label/carton/assembly separately, per-device/material/acquisition/attack strata, denominators, abstention and false findings. Research thresholds are frozen offline and never enable app findings. There is no fabricated validation report.

The shipped tests use synthetic images only. They demonstrate protocol, bounds, deterministic replay, partial coverage, artifact integrity, and evaluation plumbing. They establish no optical or attack performance.
