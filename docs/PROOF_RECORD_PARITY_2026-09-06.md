# Proof record presentation parity — September 6, 2026

The Android Proof detail and authenticated web workspace now use the website sample's Evidence, Timeline, Tracking and Receipt layout with real authorized Proof data. The sample's fictional order, video, dates and coordinates are never substituted into actual records.

## Implemented behavior

- A rounded record header contains item/order identity and current status; four accessible tabs separate review tasks, with blue active indicators and motion that respects reduced-motion preferences.
- Evidence opens committed originals inline. Media selection and playback position are retained. Bookmarks must match the original hash/version and valid elapsed ranges; corrected bookmarks replace superseded labels in the presentation while source history remains intact.
- Timeline retains event category filters/counts, chronological source times and distinct integrity events. Opening event detail and returning restores the record view.
- Tracking displays actual observations, source and test-data labels. Map pins require explicit bounded coordinates. Text-only reports retain a location-search link; no geocoded guess is presented as a reported position. Native maps support zoom, full-screen and visible attribution, with a seven-day cache for tiles requested in the visible viewport, following https://operations.osmfoundation.org/policies/tiles/.
- Receipt displays actual order/carrier context and separately fetched receiver-stage status. Existing role-gated receipt/return and reviewed-sharing workflows remain available. Viewing the tab never acknowledges receipt or sends a notification.
- Existing capture, camera barcode scanning, finalization, invitations, shipping edits/sync, custody, case, sharing and technical tools remain accessible. Inactive media is unmounted or paused. Android scrolling writes view offsets to refs instead of updating the entire app on each frame.

## Validation and release evidence

- All 102 web tests pass, including six new live-record tests; production website build passes.
- Native TypeScript and ten new Proof-record/tracking tests pass. Existing presentation/theme/Android Back/shipping queue suites pass (62 tests).
- Final Android Metro export passes: 766 modules, Hermes bundle, in-video shipping enabled. A temporary local Metro configuration allowed the retained dependency directory to be watched; it is not part of the source release.
- Workflow YAML parses. Android identity is `com.packproof.mobile`, version `0.3.3`, code `32`. The normal AAB workflow now uses `shipping-integration` and derives artifact names from the actual release identity; existing remote Play signing credentials are retained.
- The first combined GitHub build exposed a DOM/native fetch type mismatch when the web compiler checked the new native presentation imports. The upload adapter now supplies an exact ArrayBuffer view, with a regression proving sliced evidence bytes exclude surrounding backing-buffer data. Both client compilers pass after the correction.
- Website source `bcd77e7119e8b63068724f3cf74c07024be0cf64` was published as Sites version 7. Deployment `appgdep_6a9daf0524f48191821af11f19aa970f` succeeded; returned URL https://packproof-experience.packproof.chatgpt.site. The selected site's custom domain is thepackproof.com.

## Remaining release limits

No signed code-32 AAB or Play upload is claimed. The existing Android recovery build failed its Expo credential gate; this environment has neither `EXPO_TOKEN` nor an authenticated Expo session, and the repository build service reports the token missing. The corrected workflow can build once that credential is restored through the existing secret settings.

No physical-device, live carrier tile download, or browser visual test is claimed. The native local HTTP contract check did not run because its network approval was cancelled before a decision. Software tests and bundle compilation establish narrower coverage. This change introduces no new backend migrations or service deployment; the source baseline includes the prior camera/shipping and Android/eBay recovery work at `982e790084b22d1456beb3a51d41487c6a009a53`.
