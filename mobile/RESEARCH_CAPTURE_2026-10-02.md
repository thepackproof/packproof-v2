# Native research capture implementation

This branch is an experimental implementation. It must not be submitted to stores or used to make physical authenticity, liveness, camera-sensor or hardware-attestation claims.

## Isolation and use

`EXPO_PUBLIC_PACKPROOF_RND=true` enables the isolated `com.packproof.mobile.research` iOS/Android identities and `packproof-research` scheme. `research-local` is the only permitted EAS profile in this branch. Existing store build/submit npm scripts fail before executing EAS when `config/rnd/research-build.json` forbids distribution. The research profile has no submission configuration and no remote signing. Local API endpoints are limited to loopback and the Android emulator host bridge. Cached production URLs/auth configuration cannot override research runtime configuration; every native API request rechecks this boundary.

The existing product flow remains default-off. Grant versioned per-Proof research consent in the research section of a Proof before making its research capture. Learning consent is separate and is never granted by this UI. The server's independent collection, processing and display flags remain authoritative. Native capture polls the collection kill switch every five seconds while recording; policy/network loss sheds research work without stopping the encoder.

Example local prebuild (does not distribute a build):

```sh
EXPO_PUBLIC_PACKPROOF_RND=true \
EXPO_PUBLIC_PACKPROOF_API_BASE_URL=http://127.0.0.1:3000 \
EAS_BUILD_PROFILE=research-local \
npx expo prebuild --platform android --no-install
```

Use `adb reverse tcp:3000 tcp:3000` for an attached Android research device. iOS requires a supported private laboratory connection and actual development signing; simulator checks cannot qualify camera or App Attest behavior.

## Native acquisition

The existing CameraX Preview/Recorder/ImageAnalysis binding and existing AVFoundation video-data output/AVAssetWriter remain the only camera owners. No second camera, recording restart, shutter photo, mandatory gesture, lens change, or synthesized image is introduced.

The optional selector samples at most four frames per second. One pending native luma buffer/task is allowed; it never sends pixels across the JS bridge. It retains at most six native PGM luma-plane sidecars: initial context, an ambiguous/low-quality observation, a dedicated existing-barcode region winner, and three temporally separated general candidates. Images are full analysis-plane resolution, lossless luma, with no resize or invented RGB. Android reuses one in-flight native luma buffer, bounded to 2,097,152 pixels. One additional bounded native candidate cache permits asynchronous decoder linkage. iOS likewise keeps at most one in-flight plane and one immutable candidate cache, releasing camera pixel buffers immediately. Raw luma buffers total at most 4 MiB; a transient PGM encoding adds at most another 2 MiB. Disk, thermal and memory pressure disable optional work; native exceptions do not delete originals. The original recorder's existing pressure policy is unchanged.

The existing barcode decoder can promote its one unambiguous region only when it maps to the cached native frame's exact presentation timestamp and dimensions. Android reverses the declared analysis rotation; iOS uses the existing video output's transformed metadata coordinates and requires exact PTS equality. Clipped, small, multiple, expired and unmatched regions are rejected explicitly. Promotion uses real region luma/sharpness/saturation, a 750 ms cooldown and a 10% quality improvement threshold; this is frame-selection hysteresis, not a focus/exposure control driver. The preserved full-frame sidecar records the exact polygon and marks barcode identity unassigned. Task coverage keeps label OCR, serial OCR, carton, item and condition association unmet when no qualified native detector provides them. No mandatory user gesture, new ML task, or physical identity inference is introduced.

`research-acquisition.json` preserves sample identity, dimensions, rotation, own byte digest, presentation timestamps, native monotonic clock domain, relationship to recorded video, and interpretable luma/sharpness/saturation measurements. Unknown camera/exposure fields are null with an explicit reason. iOS sampled device exposure/lens position is expressly a callback-time state, not remotely attested sensor metadata. Encoder/sample mapping is approximate on CameraX; luma sidecars are not asserted pixel-identical to decoded encoded video.

Sidecars and up to 301 low-rate telemetry samples are durably written off the recorder executor. Optional finalization does not delay the original's completion marker. `research-complete.json` gates signing of the optional inventory. An incomplete research inventory can be retried; normal Proof completion remains independent. User-authorized cleanup removes only this capture's six fixed research sidecars and metadata filenames, never a directory sweep or arbitrary path.

After the original receipt closes, the optional uploader sends acquisition metadata, at most six PGM frames, and the native journal as bounded 256 KiB chunks. The server verifies the already-bound P-256 inventory signature, exact acquisition/journal hashes and frame commitments, enforces current consent and kill switches, assembles exact immutable bytes, and appends separately signed sidecar receipts. The original receipt remains unchanged. Each received image enters the source inventory with `CONCURRENT_SIDECAR`; its byte identity, parent recording, native session and temporal association are preserved without claiming pixel equivalence. Acquisition metadata must arrive before frames. Pending uploads recover from the same local files and idempotent chunk requests; failure never delays original completion. Worker source selection can use received luma frames or original color media. Physical qualification remains open.

## Final-file provenance

Research intent issuance precedes the core capture session. The server consumes the intent against the fresh core session and actor/leg, with the client's SPKI public key. Native `research-context.json` is immutable before video creation and preserves the server-signed intent, subject, app-request limitations and the dedicated key's stated protection.

After finalization, native code hashes the exact original, native journal and acquisition metadata. JS constructs RFC 8785 bytes using the shared contract; native code validates session, Proof, intent, digest, lengths and `FINAL_FILE_ONLY`, signs those exact UTF-8 bytes, and durably caches the signature/inventory for retries. Both platforms use P-256/SHA-256 with DER signatures and SPKI public keys. Android uses a distinct Android Keystore key and reports `ANDROID_KEYSTORE_UNVERIFIED`; iOS uses a distinct device-only Keychain software key and reports `IOS_KEYCHAIN_SOFTWARE`. These keys are separate from the existing biometric seller-attestation keys.

The ordinary original uploads/commits/finalizes through existing APIs. The optional close receipt runs afterward, so SDK/network delays are outside the core finalization dependency. The backend verifies the signature and exact original object bytes before recording its separate signed receipt. A file hash, signature and server receipt support separate statements; none establish scene truth. Fragment-level capture is not enabled: the Android recorder only publishes final files and the existing iOS MP4 configuration is not treated as immutable fragments.

## Platform app-request adapters

The native Android adapter uses pinned `com.google.android.play:integrity:1.6.0` Standard Integrity. An explicit laboratory Cloud project number is required. iOS calls the real `DCAppAttestService` for key generation, attestation and assertions under the development entitlement. Unsupported devices and SDK failures return unavailable, not simulated tokens.

SDK collection is additionally enabled with `EXPO_PUBLIC_PACKPROOF_RND_PLATFORM_ASSURANCE=true`; Android also needs `EXPO_PUBLIC_PACKPROOF_PLAY_PROJECT_NUMBER`. The server issues a fresh intent-bound challenge. Native calls receive its exact SHA-256 digest, never a client-selected verdict. Inventory assertions bind the SHA-256 of the actual canonical native signed inventory. Server verification, not a successful SDK callback, supplies validated state. Optional key IDs and pending SDK objects are journaled for retry; counters/replays are enforced by the server. No private key, biometric template, or raw sensor buffer goes through the JS bridge.

An additional explicit `EXPO_PUBLIC_PACKPROOF_RND_KEY_ATTESTATION=true` adapter creates a fresh AndroidKeyStore P-256 request key with the server's exact 32-byte attestation challenge. It returns the actual certificate chain, leaf public key, and a DER signature over the already-native-validated canonical inventory. The ephemeral request key is deleted after response creation; durable pending SDK objects support request retries. Its role is `ATTESTATION_REQUEST_KEY`: it neither replaces nor retroactively upgrades the recording session key. The backend independently verifies chain roots/revocation, challenge, verified boot/security level, application identity, exact inventory hash and signature. Missing vendor trust or unavailable hardware remains unsupported.

Production app distribution verdicts, Apple entitlement signing, vendor trust policy and real device behavior remain unqualified until actual builds and hardware tests are available. No build is submitted merely to gain a stronger platform verdict.

## ProofLive and ProofPilot controls

A server-issued passive challenge is recorded under `PASSIVE_LAB` only; any nonempty illumination command or active-illumination flag is rejected. The camera owner grants one exclusive lease of at most five seconds, measured with its native monotonic scheduler. Ordinary torch changes are deferred during that lease; timeout, Stop, interruption, finalization and policy cancellation release ownership and reapply the ordinary request. The lease never changes illumination itself. Start/release events record application control timing, not emitted-light timing. There is no strobe or automatic full-screen flash.

ProofPilot currently ranks real captured luma. Automatic focus/exposure proposals remain disabled until the passive recorder profile is measured on devices. Neither module claims qualified physical matching or liveness; passive correlations are research diagnostics.

## Review experience

The mobile Proof record has an isolated research section: explicit opt-in/withdrawal; committed source selection; analysis requests; cross-leg comparison requests; source-linked attributed reviewer corrections and own-statement amendments with immutable history; operational state separated from findings; original source links including worker observation time/region references; coverage, limitations and detailed server records. The original media viewer opens the actual authorized recording at the cited time. Region coordinates are shown in original decoded pixels. No conclusion-only trust score is added to recording.

Mobile can download the source-linked verification ZIP, or export a separately labeled observations-only JSON report. Research derivatives accept an explicit rectangle in source pixels, remove audio/metadata, and require manual review. The preview downloads and verifies the exact committed artifact hash and byte length before enabling approval, which binds the derivative hash and recipe hash. The reviewed derivative ZIP endpoint independently enforces server approval. Sparse geometry has XY/XZ/YZ point projections, point-to-source links, unknown-scale disclosure, and no filled hidden surfaces. Large sparse sets are displayed as a deterministic subset of at most 500 points; the committed artifact remains complete.

## Verification and remaining gates

- TypeScript: `npm run typecheck --prefix mobile`.
- Research behavior: `npm run test:research --prefix mobile` (ten tests; includes unsafe endpoints, cached credentials, source-marker distribution guard, quality values, passive challenge safety, failure semantics and all shared JCS golden vectors).
- Core recovery: `npm run test:recovery --prefix mobile`.
- Android: local `:packproof-unified-camera:compileDebugKotlin` and `:packproof-unified-camera:testDebugUnitTest` in the isolated prebuild. JUnit tests include actual Java P-256/DER signatures and shared canonical-byte digest vectors. Executed successfully on Linux with official Android SDK 36 and Gradle 8.13 in a disposable local prebuild. Initial clean compile and tests passed in 8m22s; exact-current native sources passed again in 19s. Android Metro production bundle also passed. No archive was submitted.
- iOS: pod `ResearchTests` XCTest source covers captured luma and real CryptoKit P-256/DER signatures with the same canonical bytes. It requires macOS/Xcode; Linux does not execute this gate.

Physical qualification is still required for record continuity, force-stop recovery, thermal/memory/disk pressure, exposure metadata timing, cross-device useful detail, frame-selection overhead, key loss/rotation, App Attest/Play Integrity environment behavior, actual replay attacks and safe active-light profiles. The local implementation is not a physical validation report.

## Primary implementation references

Checked 2026-10-02:

- https://developer.android.com/media/camera/camerax/analyze — ImageAnalysis backpressure and image release.
- https://developer.apple.com/library/archive/technotes/tn2445/_index.html — AVFoundation sample-buffer dropping and callback constraints.
- https://developer.android.com/google/play/integrity/setup — pinned Play Integrity library integration.
- https://developer.android.com/google/play/integrity/standard — prepare/token request binding.
- https://developer.apple.com/documentation/devicecheck/dcappattestservice — real key, attestation and assertion APIs.
- https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity — server-validation boundary.

- https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder#setAttestationChallenge(byte[]) — fresh key challenge and returned certificate chain.
