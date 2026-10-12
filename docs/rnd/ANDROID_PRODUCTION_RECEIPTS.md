# Android production capture receipts

The owner authorized Android integration and publication on 2026-10-11. The first production profile is `capture-receipts-v1`, in Android `com.packproof.mobile` version 1.0.1 (62). This document describes source behavior; it does not establish that a particular binary is uploaded, approved, installed, or live.

## Included behavior

- An actor may explicitly opt in for an individual Proof and withdraw that consent. The app rechecks current consent and account before starting an eligible fresh capture.
- The native Android module binds an immutable finalized file to the server-recorded session and an account/API-scoped device key. It signs the final bytes after ordinary recording/upload work; no passive image sampling is enabled by this profile.
- The server verifies the digital signature and source/session binding before recording a receipt. The app displays receipts beside their exact source and provides a metadata-only export. Original playback continues through the existing authenticated evidence path.
- Optional receipt failure does not turn a successful ordinary recording into a failed capture. Older or preauthorized capture paths which cannot establish the required fresh binding display that limitation.

A final-file signature binds submitted bytes and a server-recorded session. It does not authenticate a camera sensor, the physical scene, package contents, identity, custody, or the truth of a claim. No physical or scientific qualification is asserted.

## Explicit limits

Optical/model analysis, passive frame sidecars, active camera challenges, platform attestation, independent witnesses, federation and stronger privacy processing are unavailable in this production profile. Their lab code and qualification records remain isolated. No research worker runs in the production receipt profile. Existing web and desktop builds do not gain access to lab features merely because the source is merged.

The backend profile accepts only these three R&D settings:

```
PACKPROOF_RND_PROFILE=capture-receipts-v1
PACKPROOF_RND_ENABLED=1
PACKPROOF_RND_KILL_SWITCH=0
```

The Android production profile uses `EXPO_PUBLIC_PACKPROOF_RND_PRODUCTION=true` with the existing HTTPS API and Cognito identity. The separate `EXPO_PUBLIC_PACKPROOF_RND` lab flag stays false. Production releases require the committed distribution marker, the explicit distribution authorization variable, the main branch and matching source SHA.

## Staged backend rollout

1. Deploy the compatibility-only API image which accepts precisely the reviewed nine future migration ID/checksum pairs. Its existing 77 migration files and ordinary service configuration remain unchanged.
2. Build the reviewed final API image from a repository-root archive, using `docker build -f backend/Dockerfile .`. The backend imports shared evidence contracts, so a flattened backend-only archive is insufficient.
3. Run `backend/scripts/rnd-migrate.mjs --inspect` as a separate owner operator. Apply only against the same fresh inspection digest, exact source and compatible image. All nine additive migrations and their receipts share one transaction. Preserve existing authority; grant only SELECT/INSERT on the seven receipt tables to `packproof_app_runtime_v1`. No advanced-table access is granted.
4. Verify all 86 schema receipts with the ordinary runtime identity and a read-only transaction. Deploy the final image and the three bounded profile settings through the existing canary configuration.
5. Verify the completed native rollout, exact running image/source, health/readiness/authentication guards and configuration preservation before Android publication.

The compatible predecessor remains a database-compatible rollback option. Rolling back the API disables new receipt operations; clients must continue to handle optional unavailability.

## Validation boundaries

Focused checks cover actual native Kotlin policy/queue behavior, client consent and account switches, source-linked review, retry/idempotency, backend signature verification, profile isolation, and PostgreSQL transaction/privilege behavior. Production-profile native compilation and JavaScript bundling run in CI. Signed AAB identity, certificate, ELF compatibility, provenance and Play state are separate release checks.

No connected physical Android device has been supplied for this release. Automated checks must not be described as S24 Ultra camera or real-scene qualification. iOS work remains deferred.
