# PackProof iOS capture adapter

This Expo SDK 52 local module implements the shared `PackProofUnifiedCamera` contract on iOS 15.1 and later. It uses one rear-camera AVFoundation session for a portrait preview, silent H.264 MP4 recording through `AVAssetWriter`, and live barcode metadata. It never creates a competing camera or copies microphone input. Audio requests are explicitly rejected.

The writer prefers 1080p and falls back to 720p when necessary. Proof recordings are capped at five minutes and 250 MB, with storage reserve checks. Native sample timestamps track encoder progress; live barcode timestamps are approximate seek points, **not a claim that the decoded barcode exists in that exact encoded frame**. Apple does not disclose decoder execution latency or raw barcode bytes here; those values are not invented.

Live scanning intersects the OS/device's `availableMetadataObjectTypes` with Code 128, Code 39 (including Mod 43), Code 93, Codabar when available, Interleaved 2 of 5/ITF-14, QR, PDF417, Aztec, and Data Matrix. Opted-in identifier scanning adds EAN-8, EAN-13, UPC-E, and UPC-A (Apple's leading-zero EAN-13 representation). Availability of individual formats depends on iOS; e.g. AVFoundation Codabar requires iOS 15.4. Unknown formats are ignored. Two consecutive readings and bounded deduplication precede events. No frames or raw barcode values are logged.

Encoded inspection uses Vision's runtime-supported symbologies, at most twelve nearby frames, and a six-second budget checked between frames. A single system decode can outlive that soft budget. Inspection never edits or re-encodes the original. It writes at most three PNG review images with SHA-256 digests, orientation applied, and explicit `NEAR_REQUESTED_TIME` precision. These images also provide the existing review/thumbnail flow.

Files live in the application's `Documents/packproof-captures/<captureId>/` directory, matching `expo-file-system.documentDirectory`. Each capture identity reserves its original exactly once. Directories are excluded from iCloud backup and use protection until first unlock, allowing saved-file uploads while the device is subsequently locked. When engine binding is enabled, the context is immutable and the native event journal uses fsynced, SHA-256-linked JSON records compatible with the shared JS verifier. A `.finalized.json` receipt is published only after the writer, file sync, and journal complete. Unfinished original bytes are retained. Incremental media recovery, repair after force termination, and uninterrupted background recording are not claimed.

Backgrounding, camera interruption, view removal, and deactivation finalize with `interrupted=true`. A short UIKit background task allows finalization after leaving the app; it does not extend camera access. Starts and finalization have watchdogs. Late barcode callbacks cannot cross recording boundaries. Repeated stop is safe. Native receipt recovery uses the existing shared application queue; this module does not upload evidence or manage push notifications.

## Validation gates

Before distribution, compile this pod in the iOS app and run on physical iPhones. Verify silent MP4 playback, continuous capture with actual shipping labels and identifier formats, on-screen feedback, torch, repeated start/stop, five-minute limits, lock/background/interruption finalization, low storage, camera-permission recovery, exact journal hash verification, completed-file recovery after relaunch, and upload/commit before deletion. Simulator builds validate linking and compilation; a simulator cannot establish camera or device-performance parity. Linux source inspection is not an Xcode build or hardware acceptance test.

## Primary API references

- [Expo Modules API and native view functions](https://docs.expo.dev/modules/module-api/), checked against this project's installed `expo-modules-core` and `expo-camera` Swift sources.
- [AVAssetWriter](https://developer.apple.com/documentation/avfoundation/avassetwriter) and [AVCaptureVideoDataOutput](https://developer.apple.com/documentation/avfoundation/avcapturevideodataoutput).
- [AVCaptureMetadataOutput](https://developer.apple.com/documentation/avfoundation/avcapturemetadataoutput) and [metadata coordinate conversion](https://developer.apple.com/documentation/avfoundation/avcaptureoutput/transformedmetadataobject(for:connection:)).
- [Vision barcode detection](https://developer.apple.com/documentation/vision/vndetectbarcodesrequest) and [runtime-supported symbologies](https://developer.apple.com/documentation/vision/vndetectbarcodesrequest/supportedsymbologies()).
- [Required-reason APIs](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api). The bundled privacy manifest declares elapsed in-app timing, disk-space checks before writing, and access to the app's own file attributes.
