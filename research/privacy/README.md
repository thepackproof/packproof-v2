# ProofShield R&D (F07)

Experimental only. No production job, rollout, distribution upload or public assurance is enabled by this package. Originals are read only. External sharing always needs an authorized human approval of the exact derivative and recipe; detectors are candidates, not a privacy guarantee.

## Implemented boundaries

- `redact.py detect`: local OpenCV frontal-face regions, Tesseract text regions (all text conservatively considered sensitive), and screen/label quadrilateral candidates. No identity embeddings or cross-person recognition. No detector recall claim.
- `redact.py track`: pyramidal Lucas–Kanade flow on supplied regions, bounded to 500 video frames and eight seeds. Masks cover the swept region of every decoded frame; loss expands to the whole frame. It does not find every newly appearing private field. The result remains review-required.
- `create`: separately written lossless RGB PNG or lossless H.264/YUV444 MP4 derivative, opaque black masks, disclosed stored-pixel orientation, alpha compositing onto black, audio/subtitle/data/attachment removal, stripped metadata, omitted OCR/captions/thumbnails. Temporal rectangles are explicit seconds. Original SHA-256 is checked before and after.
- Signed transformation manifests identify original bytes, derivative bytes, decoded RGB pixels, mask recipe, policy and processor builds. Ed25519 standalone signatures are distinct from backend ECDSA-signed evidence extensions. `--unsigned-record` explicitly requires the server to sign its returned record.
- `recompute`: trusted source access is required; repeats the exact disclosed recipe and checks derived canonical pixels in addition to source and derivative bytes. This is a **recomputed transform**, not ZK.
- `export`: allowlists only the reviewed derivative, signed transformation record and omission notice. `approve()` verifies the original manifest signature and signs approval over the exact derivative/recipe hashes. The calling service must authorize and attribute the reviewer. Original media, filenames, thumbnails, OCR and audio never enter this archive.
- `zk/`: actual o1js 2.15.0 zero-knowledge proof of a fixed 4×4/8×8 RGB8 opaque-mask relation, with a private high-entropy field blind and domain-separated Poseidon commitments. Every pixel/channel is range constrained and every public mask bit boolean constrained. Public output digest is computed inside the relation, and offline verification decodes the actual displayed PNG and matches its exact canonical RGB8 content. RGB8 profile rejects transparency.

## Local commands

From the repository root, using Python 3.12:

```sh
python3 -m venv /tmp/packproof-privacy-venv
/tmp/packproof-privacy-venv/bin/pip install -r research/privacy/requirements.lock.txt
/tmp/packproof-privacy-venv/bin/python -m unittest research.privacy.test_redact research.witness.test_witness -v
/tmp/packproof-privacy-venv/bin/python research/privacy/redact.py detect SOURCE.png
/tmp/packproof-privacy-venv/bin/python research/privacy/redact.py track SOURCE.mp4 --masks reviewed-seeds.json
/tmp/packproof-privacy-venv/bin/python research/privacy/redact.py create SOURCE.png DERIVATIVE.png --masks masks.json --kind still --key PRIVATE-issuer.pem
/tmp/packproof-privacy-venv/bin/python research/privacy/redact.py recompute SOURCE.png DERIVATIVE.png manifest.json --trust-key TRUSTED-issuer-public.pem
npm ci --ignore-scripts --prefix research/privacy/zk
node research/privacy/zk/benchmark.mjs /tmp/packproof-zk-benchmark
node research/privacy/zk/verify.mjs research/privacy/zk/fixtures/synthetic-proof.json research/privacy/zk/fixtures/synthetic-redacted.png research/privacy/zk/fixtures/synthetic-trust.json
```

FFmpeg/ffprobe and Tesseract are external binaries. Their exact versions are recorded in transformation manifests; Tesseract unavailable is explicitly reported as missing detector coverage. FFmpeg is necessary for derivatives. All subprocesses have a 120-second cap (OCR 30 seconds); input cap 500 MB, 24 million pixels, 300 seconds, 128 masks. Heavy ZK runs remain isolated with two proving workers; operational callers must impose wall time/memory limits.

A mask is an object such as `{"x":5,"y":5,"width":20,"height":20,"start":0,"end":2,"class":"address","evidenceCritical":false}`. Pixel coordinates refer to stored pixels, not CSS display dimensions. Stills mask the full duration. Video masks apply to the closed disclosed time interval.

## Bind the hidden source before proving

```sh
node research/privacy/zk/prove.mjs commit-source CANONICAL-4x4.png PRIVATE-source-issuer.pem PRIVATE-witness.json source-binding.json
# Register source-binding.json with the immutable source inventory BEFORE choosing masks.
node research/privacy/zk/prove.mjs prove PRIVATE-witness.json source-binding.json mask-booleans.json TRUSTED-source-public.pem INVENTORY-SOURCE-SHA256 NEW-OUTPUT-DIRECTORY
node research/privacy/zk/verify.mjs NEW-OUTPUT-DIRECTORY/proof.json NEW-OUTPUT-DIRECTORY/output.png OUT-OF-BAND-TRUST.json
```

`PRIVATE-witness.json` contains the hidden pixels and blinding value. It is written with mode 0600, never exported and never committed. The source-binding issuer asserts decoding/canonicalization and links the pixel commitment to the source byte SHA-256. The proof does **not** verify PNG/video decoding, extraction, resizing, rotation, camera acquisition, truth of a scene or sufficiency of redaction. A verifier requires the expected source digest from its trusted inventory and the issuer key out of band. `proposed-public-trust.json` is material for review; trusting a prover-supplied key automatically invalidates the intended security boundary.

## Circuit/trust registry

`packproof-rgb8-opaque-4x4-v1` and `packproof-rgb8-opaque-8x8-v1` are implemented. Width=height=4 or 8, format=RGB8 version 1, transform=constant-zero per masked pixel version 1. Commitment preimage is the field sequence `[inputDomain, width, height, formatVersion, privateBlind, 3×width×height private channels]`; output digest preimage is `[outputDomain, width, height, formatVersion, 3×width×height transformed channels]`. Private channels are checked with `UInt8.check`, public mask values with `Bool.check`. Circuit verifier keys are identified by SHA-256 of o1js verification-key data and must be pinned with the circuit ID. Unknown IDs, changed keys, changed public values and missing bindings fail closed. The committed synthetic trust fixture applies only to its accompanying synthetic example, never customer proofs.

Framework: o1js Kimchi/Pasta; no application-specific trusted setup ceremony is performed. Framework parameters, commitment domain design, constraint completeness, key distribution and extraction trust need specialist review before reliance. No recursive/full-video proof is implemented. No fixed cost or security level is promised.

## Measured scope and open gates

`reports/zk-4x4-synthetic-2026-10-02.json` records an actual generated proof: compile 17.97 s, prove 12.29 s, one verification 1.286 s, 30,151-byte proof JSON, peak process RSS about 870 MiB. The 20 adversarial checks reject mask/dimensions/format/output/channel/source/circuit/key/proof changes and out-of-range private pixels. These are single-run measurements, not p95 or real-image qualification. Real proof/output/public trust fixtures are in `zk/fixtures/`; no source private key or opening is included.

F07-01/02/04: engineered and synthetic tested. F07-03: local exact-artifact review/export primitives engineered; authenticated review/grants/viewer are supplied by backend/web integration. F07-05: actual tiny fixed-image relation engineered and tested. F07-06: two tiny sizes measured; larger profiles, physical capture binding and independent cryptographic review remain open. Detector independent-corpus recall, residual privacy policy, full class coverage, production codec diversity, and automatic external export remain unqualified. Security review status: **PENDING**. Release authorization: **NONE**.

## Sources and dependencies

- o1Labs ZkProgram and serialization: https://o1-labs.github.io/o1js/api-reference/functions/ZkProgram/ and https://o1-labs.github.io/o1js/advanced-concepts/serialization/
- o1js maintained source: https://github.com/o1-labs/o1js
- OpenCV optical flow: https://docs.opencv.org/4.x/d4/dee/tutorial_optical_flow.html
- FFmpeg filters: https://ffmpeg.org/ffmpeg-filters.html#drawbox
- RFC 8785 canonicalization: https://www.rfc-editor.org/rfc/rfc8785

Pinned npm versions and integrities are in `zk/package-lock.json`; Python versions in `requirements.lock.txt`. Primary licenses: o1js Apache-2.0, pngjs MIT, canonicalize Apache-2.0, OpenCV Apache-2.0, Pillow HPND, cryptography Apache-2.0/BSD-3-Clause, rfc8785 Apache-2.0. Distribution packaging must review FFmpeg codec/build licensing and transitive notices separately.

## Actual backend research integration

`backend/src/rnd/zk-service.ts` and migration `083_rnd_zk.sql` bind the two stages to the existing authenticated, consented, durable analysis queue. Submit `proofshield` parameters `mode:"zk-enroll"` with exactly one committed canonical 4×4/8×8 PNG. The enrollment extension contains a signed source binding; private pixels/blind stay in the non-exported service table. After this job succeeds, submit `mode:"zk-prove", enrollmentId, mask:[booleans]` with the same original. The worker requires exact tenant/Proof/root/source binding and an independently configured circuit-key registry and source signer. It recomputes no resized substitute and claims only trusted processor canonicalization.

The proof result includes the real proof bundle, derivative/recipe commitments and a pending human-review state. Existing reviewed derivative export includes these disclosures. The source bytes and private witness do not enter that export. Process guard: one heavy prover per worker process, a 120-second cap, a sampled 1-GiB RSS cap on Linux, 1-MiB process output, and max one queue attempt for heavy proof jobs. An OS sandbox is still needed before multi-tenant pilot reliance; sampled RSS is not an operating-system allocation limit. Other platforms require a memory-limited configured sandbox. Database encryption, service-role isolation and retention for the private enrollment table are deployment gates.

The separate 8×8 actual run is recorded in `reports/zk-8x8-synthetic-2026-10-02.json`: compile 25.44 s, prove 16.52 s, verify 1.498 s, 30,340-byte proof, peak RSS about 961 MiB. These are single-run synthetic values, not a p95 claim. `node research/privacy/zk/benchmark.mjs --output /tmp/zk-bench --size 8` reruns it.

## Scoped research derivative grants

`backend/src/rnd/derivative-grants.ts` and migration `086_rnd_derivative_grants.sql` provide revocable, expiring bearer access to one already reviewed derivative ZIP. They are gated to the isolated research/test runtime. Creation requires authenticated Proof access, current research consent, exact artifact/recipe hashes and a matching approved review. Tokens contain 256 random bits, are delivered once, and only their SHA256 is persisted. Idempotent replay returns the signed grant with `token:null`; no generic response cache stores the secret. Expiry is bounded to 60 seconds–one day. Grant and audit rows are immutable; revocation appends a signed event.

- Authenticated `POST /proofs/:id/rnd/analyses/:analysisId/grants`, with `Idempotency-Key` and `{artifactSha256,recipeSha256,expiresInSeconds}`, returns the signed grant and one-time token.
- Authenticated `GET` on that same path lists grant/audit records without tokens; `POST /proofs/:id/rnd/derivative-grants/:grantId/revoke` with `{}` revokes access.
- `POST /rnd/derivative-grants/redeem` with `{token}` returns only the reviewed ZIP. The token is never placed in a URL. This route precedes account authentication, has an IP rate limit, and returns private/no-store headers.

Each output chunk is at most 64 KiB and rechecks expiry, revocation, current feature gates, issuer access/consent and the exact still-approved review. Changed approval invalidates old grants. Redemption start/completion/abort is signed and audited without a token or recipient identifier. Already downloaded bytes cannot be recalled. Six integration tests use a real 512×512 still redaction and cover one-time delivery, database token omission, auth boundaries, expiry, revocation during streaming, consent withdrawal and review replacement.

Authenticated revocation remains available in the research/test runtime while the kill switch is active, so an issued grant stays revoked if processing is later enabled again. The kill switch still blocks creation and redemption.
