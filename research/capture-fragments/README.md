# Encoded fragment protocol spike

This isolated software spike implements a live encoded-byte chain. It is not enabled in the native recorder. Both existing camera adapters explicitly remain `FINAL_FILE_ONLY`: CameraX exposes final `FileOutputOptions` completion, and the current AVAssetWriter configuration does not provide tested immutable fragment callbacks.

`run-spike.mjs` starts a real local FFmpeg encoder producing AVC video and AAC audio from a synthetic pattern and sine generator. The MP4 parser consumes stdout while the encoder runs, emitting only complete `ftyp + moov` initialization, closed `moof + mdat` media units, and the terminal `mfra` index. It does not split a finalized file and present the result as incremental capture.

`packages/evidence-contracts/fragments.mjs` binds each exact byte unit to session, nonce digest, ordered index, previous digest, native-independent monotonic closure time, track IDs and per-track decode ranges. The sealed P-256 manifest commits initialization, all audio/video units, terminal index, total bytes and complete encoded-stream digest. Its verifier requires a caller-pinned public key, checks every byte and chain position, and rejects omitted, reordered, truncated, rebound or altered units. The declared assurance is `SOFTWARE_ENCODED_FRAGMENT_CHAIN`; native capture and sensor attestation are unsupported. ISO BMFF parsing supports this specific FFmpeg profile, not arbitrary container variants. Codec semantic validity is checked by actual ffprobe demux in the test fixture; the manifest verifier itself is a byte/container protocol verifier.

Limits: 16 MiB per encoded unit, 128 MiB total, at most 2,048 units. Pending transport bytes are bounded. Media decode ranges are encoder timeline positions; they do not identify sensor exposure timestamps or wall-clock time.

Run locally with Node 22 and FFmpeg/ffprobe installed:

```sh
node --test research/capture-fragments/fragments.test.mjs
node research/capture-fragments/run-spike.mjs /tmp/packproof-fragment-spike
node research/capture-fragments/benchmark.mjs /tmp/packproof-fragment-benchmark
```

The five-run benchmark reports only the measured local synthetic producer population, encoded sizes, first-fragment arrival and parse/hash work. It supplies no physical accuracy estimate, mobile performance budget, hardware qualification or confidence claim. The checked-in report is `docs/rnd/validation/fragment-benchmark.json`.

A real native upgrade still requires safe encoder-produced immutable segments (including init/audio ownership), camera continuity and crash recovery on actual devices, pressure/thermal/latency measurement, final signed close verification, and explicit profile qualification. Post-finalization chunking remains a transport operation and must never be relabeled as incremental capture provenance.

## Native compile workflow

`.github/workflows/rnd-native.yml` is restricted to research branches and fails unless the source marker prohibits distribution and both app IDs are `com.packproof.mobile.research`. It installs mobile lockfile dependencies, generates disposable Expo projects under the research-local profile, and runs:

- Android: actual `:packproof-unified-camera:compileDebugKotlin` plus `:packproof-unified-camera:testDebugUnitTest`, then Metro export.
- iOS: CocoaPods resolution and unsigned `xcodebuild` for the `PackProofResearch` simulator scheme. `CODE_SIGNING_ALLOWED=NO` and no development team are supplied. The macOS image's actual Xcode/SDK version is printed in its run log.
- Fragment protocol: real local encoder fixtures and mutation tests.

The workflow has read-only repository permissions, no secrets, EAS commands, distribution upload, artifact-upload step, production endpoint, or simulator/device qualification claim. The iOS CI result is pending an actual GitHub execution; a workflow definition is not a passed compilation.

Primary references checked 2026-10-02:

- https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv — fragmented MP4 muxer options.
- https://docs.expo.dev/workflow/continuous-native-generation/ — local project generation.
- https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md — macOS 15 compiler image.
