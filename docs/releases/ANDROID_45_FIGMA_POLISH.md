# Android 0.3.16 (45) — Figma UI polish

Design source: https://www.figma.com/design/DJb0KHM720CgjbdJkKGtHr

Inspected screens: Recording (1:3), Activity (1:34), Tracking (1:83), Upload (1:113), case summary (1:133), technical appendix (1:192), design notes (1:221).

Combines the prepared cinematic candidate 904ef44 with the current platform foundation 106f186 and the latest Figma screen polish. Existing native camera, background upload, barcode feedback, account media protection, and server-owned evidence state remain in the release.

## User-facing changes

- Shared semantic colors: blue actions, teal carrier observations, violet attestations, green finalized records, amber interruptions. Text uses darker accessible variants on the Figma pastel surfaces.
- Softer cards and sans-serif headings using the already bundled fonts.
- Sliding record tabs, restrained route/card transitions, event cascades, and a compact completion notice that does not intercept touches. Reduced-motion settings disable decorative movement.
- Actual upload progress is smoothed and displayed on home cards. Unknown progress has no fabricated percentage. Completed records do not replay confirmation haptics simply when opened.
- Recording and tracking screens retain their original state, error, source, privacy and correction rules.
- Native case-packet preview separates readable evidence, gaps and 12/18 fine print from the expandable exact technical appendix. Approval SHA-256 binding and export requests are unchanged. Downloaded HTML styling is server-generated and is outside this Android-only change.

## Validation

- Mobile TypeScript check.
- Existing proof record, tracking and scroll restoration checks (25 cases).
- Existing build dependency and release identity checks (8 cases); expected identity advanced from the stale build42 expectation to this release45.
- Signed artifact verification is performed by the release build, including package, version, upload certificate, target SDK, notification permission, and foreground dataSync service.
- Physical device motion/camera playback testing remains for installation of the signed candidate.
