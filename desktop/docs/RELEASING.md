# Desktop release operations

## Release gates

1. Build and test the exact source commit. Native CI must pass for Windows x64, macOS x64 and macOS arm64.
2. Build signed staging candidates and test the complete capture → upload → server commit flow against staging.
3. Complete the hardware/failure matrix below. Record actual evidence and the tested source commit in the acceptance report.
4. Dispatch **Desktop signed release** with `channel=production` and `publish=false` to build the signed production candidate. Download the native signature/checksum records with the installers.
5. Exercise the production candidate's service configuration and signed update path under controlled accounts. Store the exact-commit acceptance report in the protected publication environment.
6. Dispatch with `publish=true` only after release approval. The workflow uploads immutable versioned binaries before switching update metadata.

The build workflow uses the protected environments `desktop-staging` and `desktop-production`. Publication uses `desktop-staging-publish` and `desktop-production-publish`. Repository administrators must actually configure these environments: a matching YAML name alone does not create review or branch protection. Restrict production to approved release refs, require an authorized reviewer, prevent self-review as appropriate, and scope publication OIDC to the corresponding environment subject. Do not put signing credentials at an unrestricted repository scope.

## Public environment variables

In each build environment, configure the values for that environment:

| Variable | Purpose |
|---|---|
| `PACKPROOF_API_BASE_URL` | Explicit HTTPS API origin; use staging credentials/data for staging |
| `PACKPROOF_WEB_BASE_URL` | PackProof website origin for approved external links |
| `PACKPROOF_COGNITO_REGION` | Existing Cognito region |
| `PACKPROOF_COGNITO_CLIENT_ID` | Public app-client ID; no client secret |
| `PACKPROOF_COGNITO_USER_POOL_ID` | Existing user pool ID |
| `WINDOWS_PUBLISHER_NAME` | Exact Common Name of the Windows signing certificate |
| `APPLE_TEAM_ID` | Organization team ID to verify against signed bundles/installers |

The workflow sets `APP_ENV`, architecture, and the platform-specific `PACKPROOF_UPDATES_URL`. It allows only `https://downloads.thepackproof.com/desktop/{channel}/{platform}/{architecture}/`. Staging and production cannot select each other's feeds. The publisher emits `latest.yml` on Windows and `latest-mac.yml` on macOS within these isolated directories.

Unsigned CI can connect to an approved development/staging backend through repository variables `PACKPROOF_DESKTOP_DEV_API_BASE_URL`, `PACKPROOF_DESKTOP_DEV_WEB_BASE_URL`, `PACKPROOF_DESKTOP_DEV_COGNITO_REGION`, `PACKPROOF_DESKTOP_DEV_COGNITO_CLIENT_ID` and `PACKPROOF_DESKTOP_DEV_COGNITO_USER_POOL_ID`. If these are absent, candidates use the verified PackProof staging API and its public Cognito client identifiers embedded in the development workflow. These are public service coordinates, not credentials. The application is labeled PackProof Dev and has an isolated local profile; production signing and update channels remain disabled.

## Required protected signing secrets

| Secret | Purpose |
|---|---|
| `WINDOWS_CERTIFICATE_P12` | Exportable Windows code-signing certificate as the electron-builder-supported PFX/P12 content or secure path |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password for that certificate |
| `APPLE_DEVELOPER_ID_APPLICATION_P12` | Developer ID Application certificate with private key |
| `APPLE_DEVELOPER_ID_APPLICATION_PASSWORD` | Application certificate password |
| `APPLE_DEVELOPER_ID_INSTALLER_P12` | Developer ID Installer certificate, required when PKG is enabled |
| `APPLE_DEVELOPER_ID_INSTALLER_PASSWORD` | Installer certificate password |
| `APPLE_NOTARIZATION_ID` | Apple account authorized for notarization |
| `APPLE_NOTARIZATION_PASSWORD` | App-specific Apple password |

An iOS distribution certificate or App Store provisioning profile cannot sign a Developer ID desktop release. The build never invents a publisher or team identity. For a Windows certificate protected by a hardware token or a cloud signing provider, extend the dedicated signing configuration and its corresponding fail-closed checks; do not export an unexportable key or disable verification.

For organizations using App Store Connect API-key notarization, the scripts also support `APPLE_API_KEY` (temporary `.p8` path), `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` plus `APPLE_TEAM_ID`. Add an approved CI step that materializes the key into the runner's temporary directory with restricted access, and delete it after the build. Never place it under `desktop/`, include it in artifacts or print it. The supplied workflow uses the app-specific-password route.

## Update distribution

Provision a dedicated S3 release bucket behind CloudFront and configure `downloads.thepackproof.com` with a valid TLS certificate. Use S3 Block Public Access and CloudFront Origin Access Control. Enable bucket versioning; retain older release objects so an already-started updater download continues to work. Do not store private evidence or account exports in the release bucket.

Required distribution behavior:

- HTTPS only; no redirects to external origins.
- `GET` and `HEAD` for release objects; correct range-request support.
- `latest*.yml`, aliases, checksum and evidence records must use minimum TTL 0 and respect `no-cache,no-store,must-revalidate`.
- Versioned application files can be cached as immutable.
- `/desktop/health.json` must return `{"service":"packproof-desktop-updates"}`; the publisher checks this before uploading anything.

In each publication environment configure `PACKPROOF_RELEASE_BUCKET`, `PACKPROOF_RELEASE_ROLE_ARN`, and `PACKPROOF_RELEASE_AWS_REGION`. The OIDC role should grant only release-prefix `s3:GetObject`/`s3:PutObject` (and the limited listing needed operationally) on the intended bucket. Staging must not write the production prefix. The workflow does not need permission to delete application objects or access evidence buckets.

Set `PACKPROOF_RELEASE_ACCEPTANCE_JSON` in `desktop-production-publish` to the completed report matching `GITHUB_SHA`. Its template is [release-acceptance.template.json](release-acceptance.template.json). Every required test must be `passed` with a concrete evidence reference, accountable reviewer and date. Compilation is not an acceptable reference for physical hardware tests.

The publication script validates all installer SHA-256 hashes, the signed verification records and updater SHA-512 hashes before any cloud write. Existing versioned objects can only be reused if their SHA-256 metadata matches; rebuilding a signed release can change timestamped signature bytes, so increment the version for a new candidate rather than overwrite a published version. Update-pointer promotion occurs after artifact uploads, separately for each platform; it is not an atomic transaction across all three feeds. A partial promotion can be completed with the same verified artifacts, or a later version can supersede it.

## Versioning, updates and rollback

Set the next semantic version in `desktop/package.json` and regenerate the npm lockfile. Keep one version for all three platforms. The app includes this version in its diagnostics and evidence capture metadata. Production updater downloads must pass the operating system signature checks in addition to the metadata hashes.

An update must not install during a capture. Pending jobs must be durably persisted and file handles closed before the updater restarts the application. Never delete the evidence directory to recover from an update problem. For a bad release, stop promotion and publish a corrected higher version; automatic downgrades are disabled. Restore a pointer only when the queued-data schema compatibility of that action has been reviewed.

macOS app signing/notarization occurs before ZIP creation, so the updater ZIP contains the stapled application. DMG notarization/stapling runs before update metadata hashing. PKG uses Developer ID Installer signing and separate notarization. `verify-artifacts.cjs` checks all three outputs before producing the release report.

## Required acceptance matrix

No entry below is considered passed merely because this file or its automation exists.

| Area | Minimum exercised behavior |
|---|---|
| Windows installation | Clean Windows 11 x64, standard user, interactive/silent install, earlier-version upgrade with real pending jobs, uninstall preserving pending evidence |
| Mac installation | Clean Intel and Apple Silicon Macs on supported macOS; DMG drag/install, Gatekeeper, optional PKG, earlier-version upgrade |
| Authentication | Sign in, verification, reset password, refresh, expired session, logout, second account unable to see/upload first account's queued evidence |
| Cameras | Built-in and USB webcams, denied/re-enabled permission, occupied device, unplug during capture, selected camera removed, microphone off/on |
| Capture | One continuous playable video, readable label, media duration, exact byte size/hash; finish/attestation and immediate next-order workflow |
| Barcodes | Code 128, QR, applicable UPC/EAN and Data Matrix; duplicate suppression, mismatch warning, physical USB scanner input |
| Upload integrity | Backend-authorized upload, SHA-256 match, commit acknowledgement, manifest integration, retry produces no duplicate evidence |
| Failures | Network loss at 5% and 95%, API failure, expired authorization, app crash, machine restart, sleep, full disk; original bytes remain recoverable |
| Marketplace | Existing Shopify/eBay orders, canonical transaction binding, known tracking match; no client-created duplicate Proof |
| Updates | Genuine signed old → new release, queue recovery, no restart during capture, valid updater signature, wrong publisher rejection |
| Workstation | 1080p and high-DPI/4K, 125–200% scaling, multiple monitors, keyboard navigation, screen-reader labels, reduced motion |
| Soak | Repeated captures/uploads across a packing shift; bounded memory, closed tracks/file handles, no continuously growing logs |
| Privacy | Camera/audio, local staging, device metadata, diagnostics and retention agree with published disclosures; no secrets or videos in telemetry |

Attach operating-system/build versions, camera/scanner models, observed outcomes and relevant redacted logs to each result. CI's native launch report verifies packaged-main startup and renderer/preload execution on a fresh development profile with sandboxing retained. Secure-storage availability is reported independently; login and physical recording remain untested. Its synthetic installer sentinel verifies installer file retention only. Neither check proves durable evidence recovery or server commitment.

## References checked for this implementation

- [Electron 44 release and macOS support](https://www.electronjs.org/blog/electron-44-0)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [electron-builder Windows configuration](https://www.electron.build/v26/docs/win/)
- [electron-builder macOS configuration](https://www.electron.build/v26/docs/mac/)
- [electron-builder NSIS options](https://www.electron.build/v26/docs/nsis/)
- [GitHub-hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

The configuration was additionally checked against the installed electron-builder `26.15.3` schema and implementation. Dependencies are locked in `desktop/package-lock.json`.
