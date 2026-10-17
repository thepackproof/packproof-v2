# Android restoration production release

## Authorization

On October 17, 2026, the owner explicitly instructed: “Push it to live production release on play console, thank you.” This supersedes the earlier release-authorization-pending statements and authorizes the Android production release. It does not establish physical-device or human acceptance; those results remain NOT RUN/pending in ANDROID-VALIDATION.md and ACCEPTANCE.md.

## Candidate

- Approved implementation: PR #104, restoration revision `c6a71d3c5e734cd51749cce5a1a951d5935d8057`, with release configuration changes recorded in this commit.
- Package `com.packproof.mobile`, version `1.0.1`, proposed version code **70** (after the recorded version 69 submission; Play must confirm availability).
- The production EAS profile explicitly enables the Android restoration flag. The build workflow checks both the committed flag and resolved app configuration, runs restoration regressions, and uses the existing frozen remote upload credential.
- HTTPS/Cognito, `capture-receipts-v1`, package identity, account media protection and existing backend settings remain intact.
- Only Android Play production distribution is authorized by this release task.

## Evidence and submission

The approved implementation passed full CI and its review APK build. The review APK is debug-signed and is not the release artifact. Record the new main source SHA, signed EAS build, AAB hash, embedded source/configuration, package/version, upload certificate and native release checks before uploading.

Release preparation passed TypeScript, 60 build/security checks, 8 review-profile checks, 8 exact-submission checks, 42 restoration command/recovery tests and 41 prototype model/contrast checks. These local checks ran under Node 24.19.0; the signed build retains its pinned Node 22 runtime.

At preparation, Play Console requires sign-in. Submission and live availability are **not yet established**. Preserve existing country targeting and unrelated testing drafts. Google review and live publication are distinct states; record the state actually shown.

Physical force-stop, native media survival, accessibility, live finalization and usability cohorts remain unverified. No historical test result is changed by the owner's release authorization.

Rollback: preserve journals and originals; do not uninstall, clear app data or rewrite manifests. If needed, issue a higher-version compatible recovery build with the restoration feature disabled.
