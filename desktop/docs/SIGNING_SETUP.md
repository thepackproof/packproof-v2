# Protected desktop signing setup

This is the configuration contract for the signed-release workflow, not evidence that a signing identity has been provisioned. Development CI artifacts remain unsigned on Windows and ad-hoc signed on macOS. Native signatures, notarization, installed acceptance, and publication are separate gates.

## Source and GitHub access

The workflow `.github/workflows/desktop-release.yml` must exist on the repository's default branch before GitHub can dispatch it. Integrate the reviewed dependency chain before release, then use the resulting exact `main` commit for signed candidates and acceptance. PR merge-test commits and earlier branch receipts are not interchangeable with that commit. Both publication IAM roles also require `refs/heads/main`.

An administrator must create and verify these environments; naming them in YAML does not establish protection:

| Environment | Configuration and protection |
| --- | --- |
| `desktop-staging` | Staging public API/Cognito values and signing configuration; selected approved branch rule. |
| `desktop-production` | Production public API/Cognito/reporting values and signing configuration; selected `main` branch, authorized reviewer, prevent self-review, disable administrator bypass where available. |
| `desktop-staging-publish` | Staging bucket/publisher role; selected `main` branch. |
| `desktop-production-publish` | Production bucket/publisher role and exact-commit acceptance JSON; selected `main` branch, authorized reviewer, prevent self-review, disable bypass where available. |

Use selected branch rules, not an unrestricted environment. Keep signing credentials in the build environments, separate from publication. Configure production reviewers before adding production credentials. The release workflow does not create environments, purchase certificates, validate business identity, or grant itself permission.

Each build environment needs `PACKPROOF_API_BASE_URL`, `PACKPROOF_COGNITO_CLIENT_ID`, and `PACKPROOF_COGNITO_REGION`. Set `PACKPROOF_WEB_BASE_URL` and `PACKPROOF_COGNITO_USER_POOL_ID` to the intended public service coordinates. Production additionally requires a valid public hosted `PACKPROOF_SENTRY_DSN`; the packaged runtime must contain the identical destination. The DSN is a public ingest identifier, never a Sentry API/authentication token. Syntax alone does not prove project ownership or delivery. The workflow constructs the environment/platform/architecture update URL on `downloads.thepackproof.com` itself.

## Windows: choose an existing signing identity

### Azure Artifact Signing with GitHub OIDC

For an existing Microsoft Artifact Signing account (formerly Trusted Signing), use the following **environment variables**. Account creation, billing, identity validation, and a Public Trust certificate profile must already be complete before this route can sign.

| Variable | Required actual value |
| --- | --- |
| `PACKPROOF_WINDOWS_SIGNING_PROVIDER` | `azure` |
| `WINDOWS_PUBLISHER_NAME` | Exact validated certificate Common Name, preserving case. |
| `AZURE_TENANT_ID` | Microsoft Entra tenant UUID. |
| `AZURE_CLIENT_ID` | Workload application/client UUID, not its object ID. |
| `AZURE_SUBSCRIPTION_ID` | Subscription UUID containing the signing account. |
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | Account's documented regional HTTPS endpoint, e.g. `https://eus.codesigning.azure.net/` only if that is its actual region. |
| `AZURE_TRUSTED_SIGNING_ACCOUNT` | Existing signing account name. |
| `AZURE_TRUSTED_SIGNING_PROFILE` | Existing validated Public Trust certificate profile name. |

Give the workload principal only the Artifact Signing Certificate Profile Signer role at the intended profile scope. Configure a GitHub federated credential for issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`, and the repository's actual exact environment subject. With GitHub's default subject this is `repo:thepackproof/packproof-v2:environment:desktop-production` (or `desktop-staging`). If the repository customizes its OIDC subject, use that actual configured subject; do not add a broad wildcard. Environment deployment rules must separately restrict the permitted branch because the standard environment subject does not encode the branch.

The Windows job grants `id-token: write`, runs `azure/login@v2`, and uses electron-builder 26.15.3 `win.azureSignOptions`. Its provider uses the Azure CLI credential in the clean GitHub-hosted runner's default credential chain. The release policy rejects local/self-hosted Azure builds, PFX credentials on this route, and competing environment-secret/certificate/password/federated-token-file credentials. It does not use or request an `AZURE_CLIENT_SECRET`.

The pinned builder serializes extra PowerShell arguments as strings; do not add boolean credential-exclusion switches through `azureSignOptions` without changing and natively validating that integration. The normal isolated runner contains no developer login state. OIDC authentication and real signing must succeed; there is no fallback to unsigned packaging. Both the app and installer still undergo independent Authenticode, exact-publisher and timestamp verification.

No exportable Windows private key is needed. Do not attempt to export a cloud/HSM-held key. Actual Azure login/signing remains untested until the account, profile, role and federation are configured.

### Existing exportable PFX/P12 identity

The default provider is `pfx`. If an already-issued usable exportable signing identity exists, set `WINDOWS_PUBLISHER_NAME` and protected secrets `WINDOWS_CERTIFICATE_P12` (electron-builder-supported base64 PFX/P12) and `WINDOWS_CERTIFICATE_PASSWORD`. They map to `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`. This is not a promise that a new public-trust certificate can be issued with an exportable key. Other HSM vendors need a separately implemented and validated signing hook; do not weaken the prerequisite or verification gates.

Correct signatures do not guarantee an immediate warning-free SmartScreen result for a newly distributed file. Evaluate clean-machine behavior with the real released binary; do not promise that EV or cloud signing bypasses reputation checks.

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

Configure publication variables `PACKPROOF_RELEASE_BUCKET`, `PACKPROOF_RELEASE_ROLE_ARN`, `PACKPROOF_RELEASE_AWS_REGION`, and production `PACKPROOF_RELEASE_ACCEPTANCE_JSON` from actual infrastructure outputs and evidence. The update host must have issued TLS/DNS and the expected health response. There is no placeholder `latest.yml` or unsigned release promotion path. See [distribution setup](../../infra/desktop-distribution/README.md) and [release operations](RELEASING.md).

## Primary references

- [electron-builder stable v26 Windows signing configuration](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/) — the unversioned documentation currently describes a different v27 schema.
- [Microsoft Artifact Signing integrations and regional endpoints](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations).
- [Microsoft GitHub OIDC signing guide](https://github.com/Azure/artifact-signing-action/blob/main/docs/OIDC.md).
- [Microsoft SmartScreen reputation guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).
- [Apple Developer ID certificate roles and types](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/).
- [Electron notarization authentication](https://github.com/electron/notarize/blob/main/README.md).
- [GitHub manual dispatch/default-branch requirement](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
- [GitHub deployment environment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
