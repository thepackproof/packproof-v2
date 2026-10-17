# Android 70 signed release candidate

The owner explicitly authorized live Android Play production release on October 17, 2026. PR #104 is merged; the approved restoration is enabled in the production build.

## Exact signed artifact

| Field | Verified value |
| --- | --- |
| Package | `com.packproof.mobile` |
| Version | `1.0.1` / `70` |
| Source | `c909e693caa84c99b12c867780b73ed5f4c1ddbc` |
| Source tree | `46034b5813807f5e1b7fce33f0cfbe420a8f79e5` |
| EAS build | `d3bc234e-6926-41d3-9084-8cfc6cec04f5` |
| Signed AAB workflow | [39020474029](https://github.com/thepackproof/packproof-v2/actions/runs/39020474029), succeeded |
| Artifact | `12096941216`, `packproof-1.0.1-70-aab` |
| AAB bytes | `46259533` |
| AAB SHA-256 | `38886f01633302bfd4c3ec6490f932ac9387f62fa5786951cd41bd382ad9fee6` |
| Upload certificate SHA-1 | `75:25:B4:FC:9A:9D:03:4A:E2:94:92:2A:D4:3D:B1:84:43:D0:E1:4D` |
| Upload certificate SHA-256 | `95:FE:CD:E5:A5:5A:47:36:43:C8:C7:C8:12:E6:94:7F:CB:2A:77:9E:12:28:FD:35:AC:18:C1:39:6F:06:11:5E` |

The downloaded archive matched GitHub's SHA-256. The exact AAB matched the workflow checksum, EAS source/profile/version, compiled manifest and packaged app configuration. The source appears in both config and bundled JavaScript. Restoration is enabled; the internal-review marker is absent. Provider authorities use the existing package. No credential file was found.

All 30 packaged 64-bit native libraries passed the ELF 16 KB checks, and the bundle specifies PAGE_ALIGNMENT_16K. R8 maps 9,041 renamed classes and preserves the Expo record Field annotation. API/authentication and existing account-media protection remain intact.

Java's signature verifier reports `jar verified` with informational warnings: the existing Android upload certificate is self-signed, has no timestamp, and the archive puts its JAR manifest last. A separate full read verified all 1,509 payload entries against the expected certificate and compared both archive-reading paths: all 1,512 entry names and contents match, with no duplicates. These observations resolve the content-mismatch concern without altering the signed artifact. They do not establish Play acceptance.

## Automated and device evidence

- [Production receipt integration](https://github.com/thepackproof/packproof-v2/actions/runs/39020473969) passed: mobile consent/recovery, receipt API with isolated PostgreSQL, production identity, native compilation, 12 native receipt unit tests, and the production JS export.
- Main CI [39020474059](https://github.com/thepackproof/packproof-v2/actions/runs/39020474059): all completed jobs passed; the full backend suite was still running when this record was prepared.
- CodeQL and Desktop CI passed on the exact source. The Android native attestation build also passed.
- Physical Android force-stop/offline/camera lifecycle, rendered accessibility, live server-finalization and human usability validation remain **NOT RUN/pending**. No device pass is claimed.

## Publication status

**Not uploaded, not submitted, not confirmed live.** Play Console opened at the known production application's publishing URL but required Google sign-in. The secure sign-in request was declined. No authentication retry, upload, review submission, rollout or country-targeting change was performed.

Version 69 is the latest recorded submission; current Play status and version 70 availability must be freshly checked in an authenticated session. Use the existing organization account and app (`8057861242145257325` / `4976194844927684128`). Preserve existing country scope and testing drafts.

`config/releases/android-70.json` selects this exact artifact and the **requested** production/completed destination; it is not evidence of a completed Play rollout and does not enable an automated submission workflow. The actual state is in [android-70-verification.json](android-70-verification.json).

Proposed release notes:

> Clearer evidence capture and save status, safer recording recovery, reliable photo progression, and a warmer, more accessible interface.

Before submission, recheck the linked CI result, current Play release state and exact bundle identity. After upload, record Google's actual review/publication state. Release authorization does not bypass Google review or establish live availability.
