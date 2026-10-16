# Android 69 release record

The owner explicitly authorized Android and webapp release on 2026-10-16, accepting that physical-device acceptance remained outstanding. Phase 2 and Phase 3 are not included.

## Exact artifact

- Application: `com.packproof.mobile`
- Version: `1.0.1`, version code `69`
- Source: `995aff78398db28e3a064cf3427646e68dd04024` (PR #102)
- Production AAB workflow: https://github.com/thepackproof/packproof-v2/actions/runs/38942136007 — succeeded
- EAS build: `16407a61-4db7-4066-bfe5-ae42d49ff721`
- GitHub artifact: `12064127586`, `packproof-1.0.1-69-aab`
- AAB SHA-256: `3748bff466f4fc679ab0561e666be015d3f9765f7733343f0c106836b3275028`
- AAB bytes: `46249454`
- Upload certificate SHA-1: `75:25:B4:FC:9A:9D:03:4A:E2:94:92:2A:D4:3D:B1:84:43:D0:E1:4D`

The downloaded archive matched GitHub's archive digest. The exact bundle matched the build checksum, embedded source and version, production profile and existing application identity. The production build verified the existing upload certificate and native 16-KB compatibility. Main CI and production receipt integration passed. Physical-device acceptance is **NOT RUN**.

## Distribution

The signed bundle was uploaded through the authenticated Google Play Console for the existing organization account `8057861242145257325` and app `4976194844927684128`. The production track showed version 68 as the current live release before this upload. The separately signed-in personal account contains the unrelated draft `com.thepackproof.app` and was not modified.

Release 13 was created with name `69 (1.0.1)`. Google accepted the bundle as version 69 with no reduction in supported devices. The production release was saved at 100% for the existing targeted countries, then the owner-authorized “Send changes for review” action was confirmed. Publishing overview now shows **Changes in review → Production → 69 (1.0.1) → Start full rollout**. Google’s quick checks were still running at the final observation; the page says the changes will enter review when those checks complete successfully. **Managed publishing is off**, so publication is configured to follow Google approval automatically. Version 69 is not yet confirmed live.

Console: https://play.google.com/console/u/1/developers/8057861242145257325/app/4976194844927684128/publishing

No new automated submission workflow is enabled; the Console submission is the sole release path for this artifact.

Release notes:

> Clearer next steps and history labels, more reliable Proof navigation and notifications, and improved evidence preview messages.

## Webapp

Web version 60 was published successfully from source `b7df525ca3d836c002343dc1fb7a6463063c694f`, applying corresponding task-copy, historical-role, and exact-Proof response fixes while preserving the newer production Site content. Deployment `appgdep_6ad263daa16c8191a36641423ba5a635` succeeded. The existing custom domain is https://thepackproof.com; the deployment also returned https://packproof-experience.packproof.chatgpt.site.

TypeScript, the production build, 389 web regression tests (including corrected fixtures rerun in affected suites), and post-build evidence-library checks passed. Browser preview QA was unavailable.
