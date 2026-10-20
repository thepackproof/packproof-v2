# SIGNAL build evidence

All six final build targets passed in [run 39425835098](https://github.com/thepackproof/packproof-v2/actions/runs/39425835098), from source **`4e5e9163383818a947cfc58519fc89474ffd8caa`**. The workflow built web first, Android second, then iOS and desktop. Later documentation-only commits do not change the application source represented by these packages.

| Target | Result | Package | Artifact |
| --- | --- | --- | --- |
| Web | Passed | Production bundle | [Download](https://github.com/thepackproof/packproof-v2/actions/runs/39425835098/artifacts/12264984628) |
| Android | Passed | Release APK with review signing | [Download](https://github.com/thepackproof/packproof-v2/actions/runs/39425835098/artifacts/12266362321) |
| iOS | Passed | Release simulator app and Share Extension | [Download](https://github.com/thepackproof/packproof-v2/actions/runs/39425835098/artifacts/12267941935) |
| Windows x64 | Passed | Development EXE installer | [Download](https://github.com/thepackproof/packproof-v2/actions/runs/39425835098/artifacts/12266646731) |
| macOS Intel | Passed | Development DMG and ZIP | [Download](https://github.com/thepackproof/packproof-v2/actions/runs/39425835098/artifacts/12267220108) |
| macOS Apple Silicon | Passed | Development DMG and ZIP | [Download](https://github.com/thepackproof/packproof-v2/actions/runs/39425835098/artifacts/12265768931) |

[build-evidence.json](build-evidence.json) records the exact run, job IDs, artifact IDs, archive SHA-256 digests, sizes and expiration dates. These GitHub review artifacts expire on 3 November 2026. Desktop downloads contain per-file `SHA256SUMS` and `release-evidence.json`. Archive digests identify the downloaded GitHub ZIP, not an individual installer inside it.

## Android package identity

- File: `packproof-1.0.1-66-4e5e91633838-local-review-debug-signed.apk`
- Size: 84,801,691 bytes
- APK SHA-256: `acdaffe77dc12789987d7e25d296eefd29310523b2061aec4f74e11c19209083`
- Version: 1.0.1 / code 66; package `com.packproof.mobile`
- Signing: generated review key, not Play signing
- Verified by the existing builder: exact source revision in both bundle and configuration, internal review marker, no packaged credentials, and 16 KB page-size alignment
- Device installation and capture verification: **NOT RUN**

Use a dedicated review device or emulator. This APK does not upgrade a differently signed Play installation. Do not uninstall or clear an existing installation that holds pending recordings.

## Scope of the result

The focused receipt/recording-review checks (5), web retained-take checks (3), and desktop evidence-engine checks (25) passed. TypeScript and bundle compilation passed. The iOS generated Share Extension project check and full Xcode simulator Release build passed. Broad end-to-end suites were not added or run for this work.

The iOS package is simulator-only, with signing disabled; no device IPA or TestFlight release was produced. Desktop development packages have isolated identities: Windows is unsigned, and macOS is ad-hoc signed without notarization. These are internal review packages, not production releases.

Installed-app visual comparison, physical camera/biometric/lifecycle behavior, account-switch integration, real canonical saved/share outcomes, and upgrade/rollback exercises remain **not executed**. Their absence is documented in [README.md](README.md) and [coverage.json](coverage.json). A successful build does not establish those acceptance results.

The earlier web/Android milestone `01e6b61aed1592f0dd772dc76623cf3024c5b192` also passed in [run 39422154754](https://github.com/thepackproof/packproof-v2/actions/runs/39422154754). Use the final-source artifacts above for review.
