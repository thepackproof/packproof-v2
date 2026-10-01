# Experimental application builds

These builds are an internal R&D implementation. Camera qualification, physical-match accuracy, shipping durability, and attack resistance are not established by compilation or synthetic tests. No store upload, TestFlight submission, Play release, public download publication, update-feed publication, or backend deployment is part of this workflow.

## Identities and defaults

| Surface | Research identity | Local API | Distribution |
| --- | --- | --- | --- |
| Android | `com.packproof.mobile.rnd`, “PackProof RND” | `http://127.0.0.1:3000` | Standalone APK, generated test signing key |
| iOS | `com.packproof.mobile.rnd`, “PackProof RND” | `http://127.0.0.1:3000` | Simulator application ZIP; no device provisioning |
| Windows | `com.thepackproof.desktop.research`, “PackProof RND” | `http://127.0.0.1:3000` | Unsigned NSIS EXE |
| macOS | `com.thepackproof.desktop.research`, “PackProof RND” | `http://127.0.0.1:3000` | Ad-hoc application signature; PKG/DMG/ZIP, no notarization |

Research mobile builds use the `packproof-rnd` scheme, do not register live website links or the production share extension, disable Expo updates, and keep separate application storage. Research desktop builds use the same dedicated scheme and a separate “PackProof RND” data directory. No automatic updater or centralized error reporting is configured. Existing store identities, version numbers, signing configuration, and release profiles retain their existing behavior.

R&D clients refuse the known live PackProof API, `thepackproof.com` subdomains, and live Cognito configuration. A separately chosen HTTPS research endpoint may be compiled into a build explicitly. The default local API requires the isolated development runner and never falls back to the live endpoint, including when React Native runs a release JavaScript bundle. The API must independently enable its research collection/analysis flags. Do not use production credentials or import real customer data into a lab environment.

## Build from this source

Install each relevant package with `npm ci`. Native builds need the platform toolchain; merely exporting JavaScript does not produce an installable application.

```sh
# Android: Java 17, Android SDK 36, build-tools 36.0.0, and Android NDK
npm --prefix mobile run build:rnd:android

# iOS Simulator: macOS, Xcode, CocoaPods
npm --prefix mobile run build:rnd:ios-simulator

# Windows: native Windows Node.js 24 runner
npm --prefix desktop run package:rnd:win

# macOS: native macOS Node.js 24 runner
npm --prefix desktop run package:rnd:mac
```

Mobile outputs are in `mobile/dist/rnd`. Desktop outputs are in `desktop/release/research/<platform>-<arch>`. Every native workflow artifact includes SHA-256 hashes. Android uses the release variant to embed JavaScript, with the generated test key rather than the production Play upload key. The iOS ZIP runs only in Simulator; it is not an IPA and cannot establish real-camera support.

To connect a USB Android phone to the local API, use `adb reverse tcp:3000 tcp:3000` and keep the isolated API running. A simulator on the same Mac can use loopback directly. A real iOS device needs a separately provisioned R&D app and an explicit isolated endpoint; those requirements cannot be satisfied by the simulator build. Research Windows/macOS binaries can run beside the normal app. Unsigned/ad-hoc artifacts may trigger platform trust prompts.

## Hosted build-only workflow

`.github/workflows/rnd-fingerprint-builds.yml` runs only for `rnd/stochastic-surface-2026-10-01`. Its workflow name is “Stochastic surface RND builds only”. It builds Android, iOS Simulator, Windows x64, macOS Intel, and macOS Apple Silicon. It uses read-only repository permissions and no cloud federation, Expo/Apple credentials, protected release environments, or deployment commands. It uploads retained workflow artifacts rather than creating GitHub releases. Artifact and log access follows the repository’s access policy; the source repository is public.

The branch push is intentionally outside the existing Android, iOS, desktop, and infrastructure push filters. The existing iOS submission listener matches only the separate workflow named `iOS`, main, and one fixed historical commit. It cannot be activated by the R&D workflow. Existing staging deployment also requires main. Do not run old release/submission workflows to obtain these artifacts.

A follow-up build can select `android`, `ios`, `desktop`, `checks`, or `artifacts` with the manual workflow input, or with a push commit marker such as `[rnd-build:android]`. The default is all artifacts. Isolation validation always runs first; selection never enables release signing or publication.

Validate the isolation contract with:

```sh
node --test scripts/rnd/build-isolation.test.mjs
```

The build check covers standalone release-bundle runtime behavior, rejection of live service configuration, separate mobile and desktop identities, and absence of publishing credentials/commands from the R&D workflow. Real S24 Ultra/A16 camera-continuity runs and independent iOS hardware qualification remain separate validation work.

## Toolchain evidence from the implementation workspace

The Linux implementation workspace provided Node.js 24, npm, Python, Git, and a Java runtime. It did not provide a Java compiler, Android SDK/Gradle, Xcode/CocoaPods, Windows, or Wine. Desktop main/renderer JavaScript was compiled locally; native Android/iOS/Windows/macOS binaries require the hosted native jobs or the listed local toolchains. A queued or configured build is not a completed artifact; consult the actual workflow outcome and artifact hashes.

The one-time `artifacts` recovery target extracts the original macOS PKGs from completed run `36900668255`, verifies the original source SHA and each package hash, and uploads smaller archives. It does not compile, sign, notarize, or publish an app. Routine desktop artifacts separate installers from disk images and exclude duplicate filename aliases to keep each archive within download limits.
