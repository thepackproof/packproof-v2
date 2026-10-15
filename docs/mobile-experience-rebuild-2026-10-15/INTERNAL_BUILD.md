# G2 internal Android build procedure

G1 implementation was authorized by the founder's **“Excellent, proceed”** response after the private review. This document covers an internal artifact only. G3 device qualification and G4 exact-build release approval remain separate.

## Artifact identity and installation scope

The existing `mobile-ux-review` profile now requests version **1.0.1 (66)**, explicitly enables the approved Android composition, and requests internal distribution and APK output. It retains package `com.packproof.mobile`, HTTPS/Cognito authentication, account-bound local evidence protection and its existing remote signing configuration. The production profile remains versionCode 65. No production identity, signing credential or backend trust policy changed.

The local build procedure uses the Expo-generated **debug key with the release build variant**. The JavaScript bundle is embedded, so a completed artifact does not need a Metro server. It is intended for a **clean spare ARM64 Android device or x86_64 emulator**. It cannot upgrade a Play installation signed with a different certificate. Do not uninstall an existing PackProof app, clear its storage or delete pending evidence to make room for this build. This procedure never installs the APK or changes an existing app.

Only ARM64 and x86_64 are review targets. The resulting APK also contains incomplete 32-bit dependency libraries: `armeabi-v7a` and `x86` omit the required `libexpo-modules-core.so`. Those remnants do not establish 32-bit support; do not call this a universal APK or install it on a 32-bit device. See the per-ABI inventory in the verification report.

There is no pre-existing ordinary side-by-side review package in this source. The research and camera-spike packages have different feature and policy semantics; they are not substitutes for this build.

The review profile retains its existing difference from production: the production-only capture-receipt flag is off. This limitation must be included in the G2 parity dossier. Neither a successful compile nor this profile demonstrates production capture-receipt runtime parity.

A read-only protocol audit found no APK certificate allowlist in ordinary Proof confirmation: the server verifies the account/Proof/media-bound P-256 signature and explicitly treats the biometric/hardware claim as client-asserted, not independently verified. Certificate/Play checks belong to separately gated research platform assurance. Thus debug signing alone is not an identified ordinary-completion blocker in current source. Valid authentication, backend policy, strong biometrics and actual device completion remain required and unverified; this is not a claim about deployed backend configuration or release-signing trust.

## Reproduction

Use Node 22 as in repository CI, the committed npm lockfiles, JDK 17, Android SDK 36, build tools 36.0.0, the React Native-pinned NDK 27.1.12297006 and CMake 3.22.1. Set `JAVA_HOME` and `ANDROID_HOME` to the installed toolchain. Network-restricted hosts must configure the existing authorized proxy and CA trust for Gradle; disabling TLS verification is not part of the procedure.

Install the mobile and backend dependencies with `npm ci`. Commit the complete implementation and test inputs first. Then run from `mobile`, substituting the exact full commit SHA and a directory outside the checkout:

```sh
node scripts/build-local-review.cjs \
  --expected-sha FULL_40_CHARACTER_COMMIT_SHA \
  --out /absolute/path/to/review-artifact
```

The script refuses a dirty checkout or a different HEAD. It resolves only the existing internal review profile, binds source provenance, disables ignored dotenv inputs, and regenerates the ignored native Android directory from committed config/plugins using `prebuild --clean`. Move any personal edits out of that generated directory before running the script. Tracked native Android inputs are refused; dependency versions are not changed, and the source tree is checked again. Generated native files remain ignored. It compiles `assembleRelease` for arm64-v8a and x86_64 using the generated local debug key. It then verifies:

- The actual package, version and signing certificate.
- The exact source SHA in the compiled JavaScript and packaged Expo config.
- The internal review marker and absence of packaged credential files.
- Every packaged native library and 16 KB ELF/ZIP alignment.
- The APK SHA-256 and final clean source tree.

Success produces the clearly named APK, `build-receipt.json`, `SHA256SUMS`, package/signing/page-size verification and build logs. The receipt explicitly marks device verification **NOT RUN**. The filename and receipt must remain together when handing off the artifact.

## Remote build restrictions

`npm run build:android:internal` currently targets the `internal-staging` **store AAB** profile despite its name; it is not this review build command. The existing Android AAB workflow also builds the production profile and must not be dispatched for this G2 APK.

A remote EAS build, if separately executed through an available authorized credential, must use `mobile-ux-review`, the frozen source SHA and `--freeze-credentials`. It must not submit to a store. The existing AWS fallback for Expo authentication is restricted to main-branch workflows. This rebuild does not broaden or bypass that trust restriction, retrieve credentials speculatively, or modify shared EAS environment settings.

## Verification limits

The prepared local environment has no connected Android device and no observed KVM device. Native screenshots, biometric confirmation, camera behavior, force-stop recovery, TalkBack, font scaling, two-account isolation and the five-user usability protocol remain unverified until measured on the required devices. Static prototype renders and model tests cannot satisfy these rows.

Build evidence must identify the exact artifact and source commit. An installable APK is an intermediate G2 deliverable, not a G3 pass or authorization for public rollout.
