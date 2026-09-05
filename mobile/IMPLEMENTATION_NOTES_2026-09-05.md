# Native signature release implementation

These changes extend the existing V2 Expo client and preserve the canonical API, immutable original evidence, optional buyer participation, and source labels. They do not assert deployment or physical-device pilot completion.

## Implemented

- First-party `CameraView` recording with deliberate start/finish, framing guides, packing/receipt recipes, user-marked elapsed bookmarks, silent recording, and an explicitly labeled interrupted segment when the app backgrounds. No gallery/video-file alternative is present.
- A server capture session is issued **before recording** for the correct account, Proof and optional lifecycle stage. The camera rejects an expired start authorization. The original is copied to app documents, with a sidecar preserving source binding/bookmarks; a post-recording SHA-256 streams in 256 KiB chunks with event-loop yields. Completed digest intent precedes upload initialization.
- Completed registration includes retained interruption and elapsed-duration reports, explicitly labeled client reports by the server. An interrupted report cannot be downgraded by a retry and a supplied duration cannot be changed. Server-verified media duration stays separate.
- Root capture, ordinary station, buyer receipt, return packing and seller return receipt send the correct session. Stage evidence is authorized through the actual stage actor; an invited receiver does not gain outbound-original access.
- Existing grading `PACKING_CAPTURE` retains its separate live-camera compatibility path and original server participant/recipe checks. It does not issue, forward, or claim a commerce capture-session attestation; ordinary fulfillment still requires one.
- Unfinished root/station recording survives explicit sign-out through credential-free account/API-scoped recovery metadata. Same-account login restores the existing local bytes and session; a different account does not inherit them. Station persists the exact upload evidence identity before transfer so a lost commit response can resume completion without rebinding.
- Native original replay, source thumbnails, seekable chapters, user bookmarks, and structured questions with resolvable source references. Optional index errors leave ordinary playback available. Feature capabilities can disable new actions without blocking original reads.
- Three deterministic case templates, readable full preview, exact-hash approval, and a separate deliberate export action. Native sharing uses the exact server HTML artifact, not reserialized content. The OS share sheet remains the final recipient/destination choice.
- Paired return anchors, linked playback with separate elapsed times, inspection zoom, explicit not-comparable states, user observations and appended corrections. Seller return receipt can use an authorized outbound thumbnail as a translucent same-angle guide. The React overlay is outside the captured video pixels.
- Native recipient preview, mandatory base status plus selectable item/shipment fields, optional previously reviewed redacted media, exact preview-hash link approval, explicit expiry, deliberate sharing, and revocation. Original sensitive-media editing routes to the full web privacy controls; unreviewed originals never fall back into the mobile receipt.
- Receipt notification opt-in/out uses the current Cognito ID token when available so verified email is established by the provider. Preferences do not affect Proof state or count as buyer acceptance.
- Press feedback remains visible with reduced motion. Proof event detail keeps the reading view mounted, retaining the user's position. Removed invented preparation percentages.

## Verification

Run from `mobile/` with backend dependencies installed:

```sh
npm run typecheck
npm run test:api
npx expo export --platform android --output-dir /tmp/packproof-mobile-bundle --max-workers 2
```

The native API contract test exercises real local HTTP routes, a real MP4 fixture, missing-session rejection, idempotent session and digest completion, changed-intent rejection, retained interruption and immutable duration reports, canonical upload/commit, original anchor lookup, supported/unsupported questions, approval-required case export, disclosure preview/grant/revocation, correct buyer stage authorization and unchanged root manifest after receipt completion.

Also verified the existing backend mobile-client, station-submission and station-state-machine groups (29 tests). `backend/tests/phase10-mobile-client.test.ts` was updated to create authorized sessions and use an actual MP4 while retaining the two-user, retry, transaction and frozen-manifest assertions.

## Release gates still requiring evidence

- A new Android binary is needed for the added native `expo-sharing` module. File sharing loads lazily and gives an upgrade/web fallback if unavailable; do not call an OTA-only rollout the complete mobile release.
- Device tests remain required on S24 Ultra and Galaxy A16 or comparable hardware: permissions, busy camera, storage full, background/force-stop, network interruption, expired authentication, resumed original/digest upload, camera versus scanner handoff, playback and readable layouts.
- Native coaching uses truthful framing and steadiness guidance. Automatic optical brightness/blur measurement is **not** implemented or claimed on native; it requires native frame processing and device performance evaluation. There is no generic visual AI, item-authenticity assessment or physical-liveness certification.
- Force-killing a camera process while recording may prevent the OS from returning a usable movie. The code never shows save success without returned and persisted bytes; no-loss claims require the plan's physical test matrix.
- Independent native remote-controller pairing is not implemented. The paired web station is the first-release multi-device surface; the native station remains direct capture with canonical order/session recovery.
- Human targets (30 coached-capture sessions, five unfamiliar receipt viewers, 20-order relay batch, faster chapter lookup and case preparation) are unmeasured. No pilot result or optical accuracy is fabricated.
- Provider production permissions, deployed source identity, paid analysis budgets, signing trust distribution, retention policy and public release remain separate system/operational gates.
