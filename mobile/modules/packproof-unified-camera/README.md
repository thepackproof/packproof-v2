# PackProof unified camera: Android hardware spike

This local Expo module is the first phase of the in-video label plan. It makes no API calls, attaches no tracking, and uploads no evidence. A successful native build does not prove Samsung hardware compatibility. The S24 Ultra continuous-recording gate must pass before backend implementation or production rollout.

## Selected stack

- Expo Modules API already present in SDK 52 (`expo-modules-core` 2.2.3).
- CameraX `camera-core`, `camera-camera2`, `camera-lifecycle`, `camera-video`, and `camera-view` **1.4.1**.
- Bundled, offline ML Kit barcode scanning **17.2.0**.

These versions match the installed `expo-camera` 16.0.18 Android dependencies; the spike adds a small application-owned adapter without upgrading shared libraries. CameraX and ML Kit are actively developed upstream; these pins are the compatibility baseline for this Expo 52 experiment, not a claim that they are the latest upstream releases.

Expo Camera 16.0.18 binds its barcode `ImageAnalysis` output only in picture mode (`ExpoCameraView.kt`, `createCamera`). Its video mode cannot satisfy this experiment. VisionCamera V4 is now archived and no longer actively maintained; current V5 introduces a different Nitro-based stack. Neither changing the Expo runtime nor patching Expo Camera is necessary for this Android-only spike.

## Native contract and lifecycle

`index.tsx` exposes `UnifiedCameraView`, its ref/types, and `isUnifiedCameraAvailable()`. Native availability is checked before requiring a view so existing binaries and unsupported platforms can import the UI safely. Expo autolinking discovers this package under `mobile/modules`.

The view binds one rear-camera `Preview + VideoCapture + ImageAnalysis` combination. There is no still-image use case. Recording and analysis never create competing camera owners. Every other camera surface must be unmounted before rendering this view. The 720p preference and analyzer resolution are conservative starting points; CameraX may choose a supported fallback. A device can reject this combination, in which case the spike reports an error instead of silently disabling analysis.

The UI requests camera permission, and optionally microphone permission. The module's manifest declares only camera permission. The dedicated spike application configuration adds audio permission; native code checks its grant again before enabling audio. Production's existing silent recording policy is unaffected by this module.

`startRecording(sessionId, audioEnabled)` resolves only after CameraX sends `Finalize`. `stopRecording()` requests that completion; it does not itself return the saved file. The recording is written directly to the application-private `files/packproof-camera-spike/<sessionId>/video.mp4`. The report directory may already exist; the video filename is reserved atomically and never overwritten. Recording is capped at ten minutes or 512 MiB; hitting a cap marks the result interrupted.

`onRecordingStarted` comes from the native `VideoRecordEvent.Start`. Barcode offsets use monotonic elapsed time at analysis entry relative to that callback. They are **approximate video offsets**, not encoder presentation timestamps: camera/encoder buffering and callback scheduling create an offset that physical playback must measure. `latencyMs` is a whole-millisecond interval from analysis entry through the ML Kit result callback. Unix timestamps are anchored to native start and advanced by monotonic elapsed time, so wall-clock changes do not change offsets.

The analyzer runs on a dedicated executor with `STRATEGY_KEEP_ONLY_LATEST`, a maximum start cadence of five analyses per second, and image closure after asynchronous ML Kit completion. Raw values over 512 characters are dropped. Repeated native results are suppressed for three seconds with bounded in-memory storage; the UI owns session-level acceptance/deduplication. Native code emits no raw barcode logs and stores no analysis frames.

Native background/detach/active=false requests stop and marks the result interrupted. The encoder binding stays alive until finalization where possible; no pause/resume stitching or automatic recording restart occurs. Late/pre-start/cross-session ML Kit results are dropped. Torch changes call CameraX control directly without rebinding. Decoder or torch failures do not stop the encoder. Only this view's use cases are unbound during cleanup.

An Android process kill or storage failure can leave an unfinished MP4. Bytes are retained for inspection, but this spike does not claim to repair that file or satisfy the later offline/recovery phase. A returned source-inactive result is marked interrupted and needs playback review; it is never submitted as Proof evidence by this module.

## Primary references

- [Expo native views](https://docs.expo.dev/modules/native-view-tutorial/) and [view methods/lifecycle API](https://docs.expo.dev/modules/module-api/).
- [CameraX video capture](https://developer.android.com/media/camera/camerax/video-capture): combined use cases remain hardware dependent; Start/Finalize represent recording lifecycle.
- [CameraX release history](https://developer.android.com/jetpack/androidx/releases/camera#1.4.1).
- [ML Kit Android barcode API](https://developers.google.com/ml-kit/vision/barcode-scanning/android): bundled detector, asynchronous processing, and required `ImageProxy.close()` after processing.
- [VisionCamera upstream maintenance notice](https://github.com/margelo/react-native-vision-camera): V4 archived after V5 release.

Compatibility decisions also used the project's installed Expo SDK 52 native sources, since Expo's old SDK 52 documentation route currently redirects to the latest SDK.
