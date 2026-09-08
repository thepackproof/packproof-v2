# Mobile capture recovery implementation — September 7, 2026

This source change implements the W04/W05 and W07 recovery/accessibility slice. It is not evidence of deployment, AAB distribution, installed device behavior, or completed pilot validation.

## Behavior

- New Android recordings require compatible `/capabilities`, the native durable camera, enrolled supported strong biometrics, an available account key, camera permission, and local space for the declared ceiling plus working space. Missing capabilities block new acquisition while Account and saved recordings remain accessible.
- The account/server/capture journal is written in protected app document storage before native acquisition. CameraX records the original directly there and writes a finalized-media marker before resolving across the JavaScript bridge. A lost bridge response can recover that original. Incomplete MP4 bytes are retained and honestly identified; process death before MP4 finalization cannot be claimed to yield playable evidence.
- Ordinary seller capture and Packing Station use one completion coordinator. It persists write intents, the original full SHA-256, stable upload ID/key, exact signed challenge, and authoritative recovery results. A received single-use upload is committed without retransmission. Lost commit, declaration and finalization responses are reconciled through exact server state.
- The provider owns bounded retries independently of the active screen, with foreground wake and a timer while the application runtime is running. Android may suspend JavaScript in background and force-stop prevents execution until reopening; no claim of continuous background execution is made. No background retry opens a biometric prompt.
- Cancellation, lockout, expired authentication/challenges and account changes retain the originating account's local original. Pending journals contain no credentials, biometric images, samples or templates. Android backup is disabled for app-owned recordings.
- Finalized local originals are retained. Account shows space usage and offers export, deliberate discard, and receipt-checked completed-copy cleanup. Cleanup requires durable evidence and finalization receipts; receipt/return media requires its own stage finalization receipt. Deleting a local copy does not delete committed server evidence.
- The exact seller statement remains unchanged. The accessible action is “Confirm and submit”; explanatory text says supported strong biometric. Generic fingerprint iconography is retained. Camera start/stop and debounced label feedback respect Android's haptic feedback setting. Packing Station uses light neutral surfaces; the existing shared Recording / Activity / Tracking hierarchy and scroll restoration remain intact.

## API contracts

`GET /capabilities`: schema 1; capture protocol 1 and positive `maxBytes`; preservation receipt version 1; seller challenge version 1, statement version 1, method `ANDROID_BIOMETRIC_STRONG`.

`GET /proofs/:proofId/recovery`: evidence and declaration operation states; root finalization; optional `stages[]` with per-stage finalization. `PRESERVED` must have the preservation receipt, signed envelope digest, operation ID and preservation time. A database commit or upload completion is never sufficient for local cleanup.

Upload initialization includes exact declared `byteSize`. `upload.received: true` means the accepted original already arrived and must not be resent with a single-use credential. Resumable part lists remain server-authoritative.

## Verification performed

- Mobile TypeScript typecheck: passed.
- Recovery suite: 10 tests pass (durable write ordering, lost commit/declaration response, delayed preservation, account change, expired challenge, bounded retries, stage receipt scope, incompatible capabilities, single-use received upload).
- Proof/scroll suites: 21 tests pass.
- Camera model suite: 8 tests pass.
- Native HTTP contract suite: 1 test passes.

Native compilation was attempted against the retained Android SDK and Gradle 8.10.2 using the updated native modules. Configuration stops before module Kotlin compilation because required Maven artifacts are not cached. A normal retry fails with `Network is unreachable` for Maven Central. This is an outstanding native compilation gate, not a source compilation pass.

## Physical release gates still require evidence

Run on the S24 Ultra and A16 5G using the exact signed AAB and intended deployed schema/API: force-stop at each boundary, interrupted recording finalization, airplane mode and reconnect, local storage exhaustion, supported strong-biometric enrollment/lockout/cancellation/invalidation, expired auth and account switching, TalkBack full-statement announcement, 200% text, system haptics off, gesture/three-button navigation, long-Proof scroll/playback restoration, and 250 MB/five-minute safe ceilings. Inspect actual device-owned files and requests for biometric data minimization. Record installed build IDs and results; do not infer them from unit tests.
