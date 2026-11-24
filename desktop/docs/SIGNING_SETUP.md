# Protected desktop signing setup

This is the configuration contract for the signed-release workflow, not evidence that a signing identity has been provisioned. Development CI artifacts use ad-hoc signatures on macOS. Native signatures, notarization, installed acceptance, and publication are separate gates.

## Source and GitHub access

The workflow `.github/workflows/desktop-release.yml` must exist on the repository's default branch before GitHub can dispatch it. Integrate the reviewed dependency chain before release, then use the resulting exact `main` commit for signed candidates and acceptance. PR merge-test commits and earlier branch receipts are not interchangeable with that commit. Both publication IAM roles also require `refs/heads/main`.

An administrator must create and verify these environments; naming them in YAML does not establish protection:

| Environment | Configuration and protection |
| --- | --- |
| `desktop-staging` | Staging public API/Cognito values and signing configuration; selected approved branch rule. |
| `desktop-production` | Production public API/Cognito/reporting values and signing configuration; selected `main` branch, authorized reviewer, disable administrator bypass where available. Preserve the owner-approved self-review setting. |
| `desktop-staging-publish` | Staging bucket/publisher role; selected `main` branch. |
| `desktop-production-publish` | Production bucket/publisher role and exact-commit, platform-scoped acceptance JSON; selected `main` branch, authorized reviewer, disable bypass where available. Preserve the owner-approved self-review setting. |

Use selected branch rules, not an unrestricted environment. Keep signing credentials in the build environments, separate from publication. Configure production reviewers before adding production credentials. The release workflow does not create environments, purchase certificates, validate business identity, or grant itself permission.

Each build environment needs `PACKPROOF_API_BASE_URL`, `PACKPROOF_COGNITO_CLIENT_ID`, and `PACKPROOF_COGNITO_REGION`. Set `PACKPROOF_WEB_BASE_URL` and `PACKPROOF_COGNITO_USER_POOL_ID` to the intended public service coordinates. Production additionally requires a valid public hosted `PACKPROOF_SENTRY_DSN`; the packaged runtime must contain the identical destination. The DSN is a public ingest identifier, never a Sentry API/authentication token. Syntax alone does not prove project ownership or delivery. The workflow constructs the environment/platform/architecture update URL on `downloads.thepackproof.com` itself.

## Apple: Developer ID plus notarization

The team must already have an eligible Apple Developer membership and Developer ID signing identities. The Apple Account Holder is required to create Developer ID certificates through the developer account. Reuse existing valid identities when possible; never revoke an identity merely to recover a missing private key.

| Build-environment item | Type | Purpose |
| --- | --- | --- |
| `APPLE_TEAM_ID` | Variable | Exact organization Team ID checked against signed app and PKG. |
| `APPLE_DEVELOPER_ID_APPLICATION_P12` | Secret | Developer ID Application identity including private key, base64 P12. |
| `APPLE_DEVELOPER_ID_APPLICATION_PASSWORD` | Secret | P12 export password. |
| `APPLE_DEVELOPER_ID_INSTALLER_P12` | Secret | Developer ID Installer identity including private key, base64 P12; required for PKG, enabled by default. |
| `APPLE_DEVELOPER_ID_INSTALLER_PASSWORD` | Secret | Installer P12 export password. |
| `APPLE_NOTARIZATION_ID` | Secret | Authorized Apple account login. |
| `APPLE_NOTARIZATION_PASSWORD` | Secret | App-specific password, never the main account password. |

The Account Holder can prepare missing identities through Apple's certificate workflow, install the certificate into the keychain containing its matching private key, and export the identity as password-protected P12. A downloaded `.cer` alone has no private key. An iOS/App Store distribution identity cannot replace Developer ID Application or Developer ID Installer.

The current workflow uses Apple account/app-specific-password notarization. The underlying scripts also accept a team App Store Connect API key (`APPLE_API_KEY` temporary `.p8` file, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`), but that workflow path needs a reviewed temporary-key materialization and cleanup step before use. Never paste private keys into the issue, PR, report, or chat.

Packaging signs the app with hardened runtime and camera/microphone entitlements, notarizes/staples it, creates the update ZIP, and separately notarizes/staples DMG and PKG. Native verification checks Developer ID team, signatures, hardened runtime, notarization, stapling and Gatekeeper before recording success. No signed Mac release has been demonstrated by the development smoke test.

## Reporting and installed acceptance

The acceptance record must include `centralized-error-reporting-delivery`: real receipt of a predefined sanitized event in the intended owned Sentry project, verified event payload/redaction, exact source commit, reviewer and date. Use the [monitoring activation procedure](monitoring-activation.md) and its explicit canary command. An ingest HTTP acknowledgment alone is not project readback or delivery acceptance. Do not use order contents, account identity, recordings, tokens or arbitrary error text as a test event. Existing reporting behavior is unchanged: only predefined codes and application details are accepted; development reporting is disabled.

Use the installed-acceptance kit for the full hardware, failure, account, marketplace, accessibility, privacy and signed old-to-new update matrix. Keep every untested case pending. Production publication fails unless all required cases have actual evidence for the exact release commit.

## Build, verify, then promote

After protected configuration and default-branch integration, dispatch `Desktop signed release` for staging with `publish=false` and `include_pkg=true`. Resolve real provider failures without bypassing checks. Download the signed outputs and verification receipts for clean-machine acceptance. Repeat for production with its distinct runtime/service identity; complete the exact-source acceptance record before any production promotion.

Configure publication variables `PACKPROOF_RELEASE_BUCKET`, `PACKPROOF_RELEASE_ROLE_ARN`, `PACKPROOF_RELEASE_AWS_REGION`, and production `PACKPROOF_RELEASE_ACCEPTANCE_JSON` from actual infrastructure outputs and evidence. The update host must have issued TLS/DNS and the expected health response. There is no placeholder `latest-mac.yml` or unsigned release promotion path. See [distribution setup](../../infra/desktop-distribution/README.md) and [release operations](RELEASING.md).

## Primary references

- [Apple Developer ID certificate roles and types](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/).
- [Electron notarization authentication](https://github.com/electron/notarize/blob/main/README.md).
- [GitHub manual dispatch/default-branch requirement](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
- [GitHub deployment environment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
