# In-video shipping labels: camera gate

> Historical implementation/research. The September 8 candidate supersedes ordinary scan/rescan choreography with Orders → one video → review → automatic authoritative completion. Legacy journal recovery remains supported. See [current redesign contracts and gates](ui-ux-redesign-2026-09-08/README.md).
This change implements the **Phase 1 camera spike** from [the supplied plan](IN_VIDEO_SHIPPING_LABEL_PLAN.md). The full shipping feature is not complete. Section 32 explicitly requires reliable simultaneous operation on the S24 Ultra before backend changes. The user reported successful S24 Ultra recording with seamless barcode detection, haptics, and visual feedback on September 5, 2026. This closes the initial simultaneous-recording feasibility gate and authorizes the carrier integration work. The detailed acceptance matrix below remains unexecuted unless explicitly recorded.

## What changed

- A standalone Android camera test, enabled only by `EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE=true`. Its package is `com.packproof.mobile.cameraspike`, displayed as **PackProof Camera Test**, so it installs beside PackProof. No sign-in or server connection is used.
- A local Expo Android module binds CameraX Preview, VideoCapture, and ImageAnalysis together. ML Kit scans asynchronously with keep-latest backpressure. Recognition does not restart the camera or touch the encoder configuration. Torch updates do not rebind the session.
- Silent video is the default; an optional microphone test requests audio permission. The normal app keeps its current silent policy and identity. The Play release profile rejects the spike flag.
- Barcode observations are diagnostics, not shipping identification. All supported formats, including unrelated UPCs, can appear in this test. No parser, carrier inference, tracking binding, registration, provenance mutation, or Proof upload is performed.
- First-read haptics, animated masked detection badges, duplicate suppression, bounded reports, native timestamps, local playback, approximate jump-to-scan, and explicit sharing of a report/video.
- Unique app-private video files are written directly to `files/packproof-camera-spike/<sessionId>/video.mp4`. A serialized journal records masked diagnostics beside the movie before recording begins and during recognition. These files never enter production capture recovery or evidence submission.
- Backgrounding, view loss, and camera interruptions stop the current recording. They never resume or stitch it. Hardware Back asks whether to finish and save. A process kill may leave an unplayable MP4; recovered files are retained but never described as a completed continuous capture.

## Technology decision

The current repository already uses an in-app `NativeCaptureHost` with Expo Camera, rather than the external system recorder described in the plan's current-state section. Installed Expo Camera **16.0.18** binds its image analyzer only in picture mode; video mode binds preview and video alone. Adding a JavaScript barcode callback cannot enable concurrent analysis in that native version.

The spike therefore uses supported CameraX APIs in a local Expo module. CameraX **1.4.1** and bundled ML Kit **17.2.0** match the app's existing Expo Camera Android dependencies. No node_modules patches, parallel camera owner, VisionCamera migration, or Expo SDK upgrade is introduced. VisionCamera's current major-version transition would add unrelated framework compatibility work; this does not establish that a future version is unsuitable.

The implementation depends on the device supporting all three use cases concurrently. Unsupported camera combinations fail visibly; the code does not silently disable detection or fall back to a second camera. The existing packing flow remains available in the ordinary app.

See the [native module notes](../mobile/modules/packproof-unified-camera/README.md) for primary sources and timing limitations.

## Build and run

The **Android camera spike** GitHub Actions workflow builds a standalone arm64 APK from this branch. It uses the generated Android debug test key for the separate test package and bundles JavaScript into the release variant; a Metro server, Expo login, Play upload key, and carrier credentials are not required. This APK is a test artifact, not a Play release.

Local equivalent (Node 22.18+; Java 17; Android SDK/build tools installed):

```bash
cd mobile
npm ci
npm run typecheck
npm run test:camera-spike
EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE=true npx expo prebuild --platform android --no-install
cd android
EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE=true ./gradlew assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a
```

The artifact is `mobile/android/app/build/outputs/apk/release/app-release.apk`. Rebuilding against a new generated debug key may require removing an earlier camera-test package; share any videos/reports first because uninstalling removes app-private files. The main PackProof application has a different package.

## Physical acceptance record

Use synthetic carrier labels or non-sensitive test labels. The JSON report stores masked barcode values, but video contains whatever the camera saw. Use **Share masked test report** and **Share test video** explicitly when ready to supply results.

| Check | S24 Ultra | A16 5G | Evidence required |
|---|---|---|---|
| 2–5 minute continuous packing recording | NOT RUN | NOT RUN | Playable video with no freeze/restart around each scan |
| UPS, USPS, FedEx test labels during recording | NOT RUN | NOT RUN | Native callbacks and readable label moments in same clip |
| Barcode left visible for 10 seconds | NOT RUN | NOT RUN | One retained masked observation/haptic per unique code |
| Multiple label barcodes | NOT RUN | NOT RUN | Diagnostics of multiple codes; filtering/binding is a later phase |
| Unrelated UPC and QR/contact payloads | NOT RUN | NOT RUN | UPC can be diagnostic; no shipping binding; URL/contact not retained |
| Network disabled | NOT RUN | NOT RUN | Local capture and diagnostic persistence work without requests |
| Background, return, force-stop/relaunch | NOT RUN | NOT RUN | Interrupted state; recovery retains files; no continuity claim |
| Jump to barcode | NOT RUN | NOT RUN | Approximate indexed offset matches visible label in playback |
| Camera permission deny/revoke/restore | NOT RUN | NOT RUN | Clear permission feedback and retry |
| Optional audio deny/allow | NOT RUN | NOT RUN | Silent path remains available; audio-enabled clip plays correctly |
| Android hardware Back | NOT RUN | NOT RUN | Cancel keeps recording; finish preserves video |
| Torch and longer thermal run | NOT RUN | NOT RUN | No restart, acceptable device heat and frame stability |

Record device model, Android version, APK commit/hash, duration, visible issues, and report/video references with each result. Detector latency is native analysis duration, not a measurement of overall label-entry-to-recognition time. `detectedAtMs` is an approximate monotonic offset from the native video-start callback; it is not cryptographically authenticated frame timing. `hardwareValidation` deliberately remains `UNVERIFIED` in generated reports.

## Next phases after the physical gate

1. Integrate the proven recorder into the existing server-authorized capture session and durable evidence pipeline behind the unified-capture feature flag.
2. Add conservative tracking extraction and server-authoritative seller-scoped, idempotent, conflict-safe binding.
3. Correlate capture observations to committed video without calling them carrier-confirmed facts.
4. Reuse trusted shipment sync / EasyPost, with durable retries and no effect on recording if the provider fails.
5. Persist and replay pending bindings across network/auth recovery; surface shipping identity and jump-to-label in Proof review.
6. Run the complete backend/mobile regression and S24/A16 matrix. Remove mandatory finish rescan only after hardware validation.

Production EasyPost credentials, webhook verification/configuration, operational smoke tests, and production rollout remain separate gates. The standalone spike keeps its diagnostic behavior. Follow-on backend and normal-app changes are documented separately in [capture shipping integration](CAPTURE_SHIPPING_INTEGRATION.md).

## Validation status — September 5, 2026

- Full mobile TypeScript: passed.
- Eight diagnostic tests: passed (recording boundaries, duplicate suppression, payload privacy, bounded input/clocks, flood limits, recovery metadata, sticky interruption).
- Android Metro export: passed, 759 modules.
- Android Expo prebuild: passed in a separate validation copy. Generated package and scheme are the dedicated test identity; release variant uses the generated debug test signing configuration.
- Expo native-module discovery: passed; local module resolves to `com.packproof.unifiedcamera.UnifiedCameraModule`.
- Normal-app identity/audio policy and rejection of the spike flag in the Play profile: passed. Prebuild inspection found and corrected the image-picker plugin removing the test microphone permission; the generated test manifest retains it.
- Native Gradle compilation / installable APK: **passed** in [Android build 33998320266](https://github.com/thepackproof/packproof-v2/actions/runs/33998320266), from source commit `334f170b7a67bab2325dcb5d166c24aa1961fc93`. An earlier run compiled successfully but its inspection step required `rg`, absent from the runner. The inspection now uses Node's standard library; the corrected workflow completed successfully.
- Artifact identity: `com.packproof.mobile.cameraspike`, version `0.3.0`, code `29`; APK Signature Scheme v2 verification passed. JavaScript is bundled. APK size is **85,805,807 bytes**. Its SHA-256 is `a877a4f46696f5fa48a417aa7da99e8a661e2bc4f3b16396c113982b9d2489c5`; the downloaded archive and extracted APK match their CI checksums, and ZIP integrity checks pass.
- Source publication: explicitly authorized and published on `codex/in-video-camera-spike`; [draft PR #30](https://github.com/thepackproof/packproof-v2/pull/30). CI and CodeQL both passed for the APK source commit. Subsequent documentation updates do not change the built application.
- S24 Ultra basic simultaneous recording / recognition / haptic and visual feedback: **passed, user-reported**. Device OS, recording duration, and individual carrier labels were not supplied. A16 and the extended hardware matrix remain untested.
- Follow-on integration: see [capture shipping integration](CAPTURE_SHIPPING_INTEGRATION.md).
