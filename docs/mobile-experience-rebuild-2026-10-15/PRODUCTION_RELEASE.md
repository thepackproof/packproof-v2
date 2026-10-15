# Android production release preparation

## Authorization and scope

The founder subsequently instructed: **“Excellent, submit to live.”** This authorizes the Android production release work and supersedes the earlier packet's release-authorization-pending statements. It does not change historical test results or establish physical-device acceptance.

This release combines the reviewed Android rebuild stack (PRs #88–#96) in one integration change against `main`. The frozen internal-review source remains `fbc1821ce687f95052d1e11df46e3cb55bff4977`; its version 66 debug-signed APK is not a Play upload artifact. No partial slice should be merged separately into `main`, where mobile changes automatically trigger the signed AAB workflow.

## Production candidate

- Package: `com.packproof.mobile`; version name: `1.0.1`.
- Candidate version code: **67**, provisional until Play Console confirms it is unused. Building an artifact does not reserve this code in Play.
- Explicitly enable `EXPO_PUBLIC_PACKPROOF_ANDROID_TASK_FIRST=true` in the production EAS profile. The workflow rejects a missing or false committed value before resolving build identity.
- Preserve production HTTPS/Cognito configuration, `capture-receipts-v1`, existing EAS project and frozen remote upload credentials. The review profile remains version 66.
- Use the existing guarded Android AAB workflow after a single integration merge. It builds and verifies an artifact; it does not submit it to Play.
- Do not modify backend, web, desktop production deployments or iOS submission as part of this release.

## Verification and remaining evidence

The production preparation changed the EAS version/flag, the workflow flag guard, and corresponding tests. Node 22.14.0 validation passed: `npm run test:build-security` (59/59), `npm run test:local-review-build` (8/8), and `git diff --check`. The frozen internal source's broader CI and local results remain recorded in [VERIFICATION_REPORT.md](VERIFICATION_REPORT.md); they are not a claim that the new production binary has been tested on a device.

Physical Android, native accessibility, user-journey, production-receipt parity and rollback acceptance in [NATIVE_ACCEPTANCE_MATRIX.md](NATIVE_ACCEPTANCE_MATRIX.md) remain **NOT RUN**. No successful device installation, biometric/camera execution or unfamiliar-user acceptance is claimed.

Before submission, record the exact main source SHA, EAS build identity, AAB hash, manifest/package/version, upload certificate, bundled source/profile, native ABI completeness and 16 KB checks. Resolve actual defects before publication. The workflow's distribution authorization, authentication and signing checks must remain enabled.

Play Console access must be restored to verify the existing application, unused version code, upload certificate and production release scope before uploading the exact artifact. Preserve existing country scope and testing drafts. A submitted or in-review release is not yet a live release; report the actual observed Console state.

## Submission status

At preparation: **not submitted**. Secure Play sign-in timed out; a fresh Console check did not establish an authenticated session. No Play release, country scope, rollout or testing draft has been changed.
