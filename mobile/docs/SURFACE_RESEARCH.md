# Native surface research adapter

Status: experimental source implementation, not an optical qualification. No distribution submission is authorized. No supported physical identity profile exists yet.

## Camera ownership and feature-off behavior

Android already bound CameraX Preview, VideoCapture and a single keep-latest ImageAnalysis at nominal 1280×720. The new sampler reuses the exact ImageProxy after the existing ML Kit task completes. It does not add a use case, request still capture, change resolution, switch lenses, or rebind while recording. The asynchronous ML task keeps its proxy until optional analysis completes; a finally block closes it. The analyzer executor now stays alive until outstanding callbacks finish at destruction.

iOS already writes the AVCaptureVideoDataOutput sample buffers into AVAssetWriter, with a preview and barcode metadata output. The new sampler sees only samples accepted by the existing writer. It retains at most one pixel buffer on a utility queue, verifies barcode association on that sample with Vision, and leaves the video queue immediately. No additional AVFoundation output is configured.

Collection requires every gate: R&D build flag, compiled feature flag, per-account/per-server explicit opt-in, server collection capability, supported native module. Production build defaults remain off. Proof loading primes an account/proof-bound capability cache valid for two minutes; Record never performs a new surface network request. Opt-in storage reads have a 750 ms deadline. Missing/stale permission cache disables optional collection for that recording. Local settings do not enable backend extraction, internal comparison, or findings.

## Selected originals and association

The selector requires exactly one distinct decoded value matching the expected shipment, three consecutive overlapping barcode observations, and diagnostic luma eligibility. Barcode equality selects context only; it is not physical identity or a package track. Several labels with identical content in the same view remain a research limitation. Multiple different decoded values or a lost track reset candidate stability.

The latest six eligible full stream-sized JPEG frames are retained at least 1.5 seconds apart to prefer a later labeled-package segment. Their status does not establish that the label is attached or the package closed. Android saves an unrotated analysis stream frame and records its rotation; iOS saves the writer's portrait pixel buffer. JPEG encoding quality 95 is recorded as an acquisition transform. These are stream originals, not raw sensor photos or full-resolution still-camera originals. No resize, generative processing, or crop changes the saved original.

Rolling candidates have unique filenames. Replacement is journaled before only the superseded, uncommitted candidate JPEG is deleted. Nothing uploads until FINISHED exists. A process termination leaves an incomplete journal and keeps remaining bytes; it does not invent a completion event. Source retention is bounded by six selected frames, at most seven during an atomic replacement, and an 8 MiB aggregate byte admission budget. Sampling is capped at 200 candidate saves; reaching any budget records an unavailable reason. Current count/size budgets are engineering limits, not measured identity accuracy.

Android timestamps are approximate encoder progress plus native sensor and monotonic values. iOS records the same sample's relative writer PTS. Unavailable ISO/exposure/focus distance/glare/motion/view angle stay null. Quality measurements are diagnostic and explicitly uncalibrated. Missing expected tracking produces an explicit unavailable event, preserving normal capture.

Worker polygons use source pixel centers, bounded to [0,width−1] × [0,height−1] in TL/TR/BR/BL order; native edge-coordinate boxes are transformed and clipped to that convention. The uploader supplies exact source hashes, dimensions, acquisition metadata, source-video hash, source-mapped barcode polygon, context polygon, and optional geometric region hints. Carton candidates inferred downstream are unvalidated. No independent carton identity is claimed. Barcode tracks cannot be treated as independent physical region support.

## Durability, scope and recovery

Native context and hash-chained event bytes are fsynced in private application storage. iOS uses file protection and backup exclusion inherited from CaptureStorage. JavaScript receives metadata only; image/video hashing is streamed natively and uploads stream local files. Sidecar recovery stores source registrations, stable idempotency keys, exact frozen command and request intent before requests. Account/server changes stop upload. Retrying repeats the same source/command identity, including after a response is lost. Native source hashes are checked again before transfer.

Ordinary packing records can passively enroll OUTBOUND. The adapter and API retain RETURN_PACKING as a distinct RETURN enrollment, but the existing app has no return-leg tracking field: native return sampling currently records NO_EXPECTED_SHIPMENT_IDENTIFIER rather than reusing outbound tracking. Research operators can exercise return enrollment through the server contracts with independently bound source data; automatic return selection awaits a return-label identity source. A separate optional recipient Compare package action reuses the same NativeCaptureHost and records a local observation video. It supplies a null ordinary capture-session ID to the additive surface API. Context stage is explicitly a participant statement; the server reports acquisition assurance UNVERIFIED. No sensor attestation or server-observed capture time is claimed. The later body-bound server intent authenticates the request, not the scene.

Surface uploads never delete the original packing video, change ordinary upload cleanup, rewrite the finalized root, or block ordinary video submission. A failed optional upload remains visible in the Proof research panel with a manual retry. Incomplete/interrupted captures remain local for investigation and cannot be auto-enrolled. Disabling collection prevents new sampling; preserved evidence remains accessible. No local originals are automatically removed after surface upload. A video digest is checkpointed immediately after native completion and before optional source upload. Automatic enrollment begins after ordinary evidence commit so the server can bind its canonical video reference. If core cleanup already removed the local video, recovery can use the exact server-committed capture-session evidence hash and byte size. Standalone later observation videos remain local and are explicitly device-reported, without a server-committed context-video claim.

## Implemented user flow

In an R&D build, Account exposes explicit research consent and data-use text. Normal seller recording adds passive collection. The Proof panel shows collection availability, enrollments and optional recipient observation with before/during/after/unknown stage. Comparison jobs are requested only when the internal-comparison flag permits them. The panel shows unqualified/unsupported/inconclusive states, source and method details, authenticated original frame views, explicit JSON export through the OS share sheet, and pending upload recovery. It contains no overall verified badge. Participation is optional and free.

## Validation run in this change

`node --import ./backend/node_modules/tsx/dist/loader.mjs --test mobile/tests/surface-research.test.ts mobile/tests/capture-recovery.test.ts mobile/tests/native-api-contract.test.ts`

26 targeted unit/protocol tests passed initially: gates, journal integrity/torn tails, source budgets, rolling replacement, source-coordinate rotations, immutable request commitments, existing native API contracts and capture/recovery behavior. `tsc --noEmit -p mobile/tsconfig.json` passed. A further production-mobile-helper → real Python worker JPEG contract test passed, including Android rotation and full-frame boundary coordinates. These tests do not validate optical accuracy, device throughput, OS file durability, or native build success. Native compiler outcomes belong to the R&D build report.

## Required physical-device gate, all NOT RUN

- S24 Ultra → S24 Ultra, A16 → A16, S24 Ultra → A16 and reverse; independent midrange Android; at least one real iPhone. Record exact OS/lens/stream/compression combinations.
- Continuous normal packing with feature off/on: native frame-time/PTS, encoder drops, ML latency, memory, battery/thermal effects and time to stop/finalize. No improvement in capture quality may come from an extra seller step.
- Low disk, injected write error, Android low-memory status, iOS memory warning, thermal pressure, background/foreground, camera interruption and process death. Ordinary video must remain preserved; incomplete sidecar must abstain.
- Loose label early versus final attached label, package switching, multiple identical-content labels, ambiguous barcodes, track loss, glare, label over-tape and label transfer. Confirm candidates do not assert carton identity or closure.
- Two-device same-label captures, separately printed identical content, moved label/different carton, damaged/obscured required groups, replay/reprint attacks. Freeze scientific thresholds only after held-out measurements.
- Offline/lost-response recovery, source bytes altered after selection, wrong account/server, expired intents, backend kill switch and source retention expiry.

Pass/fail optical qualification, latency budgets and acceptance-error rates remain unmeasured. Until that gate is executed, research findings cannot become customer-visible physical identity conclusions.
