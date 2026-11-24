# PackProof Desktop

Installable macOS fulfillment workstation built from the existing PackProof repository. The renderer is local React; Electron's main process owns authentication, evidence staging, uploads and operating-system integrations. The backend remains authoritative over transaction identity, permissions, evidence commit and finalization.

## Run the development application

Use Node.js 24 and install dependencies inside `desktop/`:

```bash
npm ci
npm run check
npm run test:release
npm run dev
```

Provide the public service configuration when building a connected candidate. The Cognito client must be the existing public client approved for username/password authentication; never include a client secret.

```bash
APP_ENV=development \
PACKPROOF_API_BASE_URL=https://YOUR-STAGING-API \
PACKPROOF_COGNITO_REGION=us-east-1 \
PACKPROOF_COGNITO_CLIENT_ID=YOUR_PUBLIC_CLIENT_ID \
PACKPROOF_COGNITO_USER_POOL_ID=YOUR_USER_POOL_ID \
npm run dev
```

Service values are embedded in `dist/main/runtime-config.json`; a packaged application does not obtain new service or update origins from a renderer setting. A build without usable service configuration shows the configuration error rather than inventing accounts, orders or successful uploads.

The packing workflow is order selection → selected-camera preview → one continuous recording with local barcode recognition → deliberate finish/attestation → durable local queue → background upload/commit. Local capture state is distinct from server Proof state. A captured file must remain available until the backend acknowledges accepted evidence or its owner explicitly discards it.

## Packages and operating systems

| Platform | Packages | Minimum target |
|---|---|---|
| macOS arm64 | `.app` inside `.dmg`, updater `.zip`, optional `.pkg` | macOS 13 or later |
| macOS x64 | `.app` inside `.dmg`, updater `.zip`, optional `.pkg` | macOS 13 or later |

Electron 44 does not support macOS 12. For signed distribution, build on macOS with `npm run package:mac`. Set `PACKPROOF_BUILD_PKG=1` to include PKG and `PACKPROOF_BUILD_ARCH=x64` or `arm64` to select the matching native target; pass `--x64` or `--arm64` to electron-builder when needed. Run `npm run verify:artifacts` after packaging to produce convenient download aliases, checksums and verification evidence.

For an **unsigned development** cross-build only, set `PACKPROOF_BUILD_PLATFORM=darwin` to match the explicit electron-builder target. Cross-building does not replace native signing or operating-system tests. No production command silently falls back to an unsigned installer.

Output is under `release/{channel}/{platform}-{arch}/`. Production includes versioned artifacts and `PackProof.dmg` and optional `PackProof.pkg` aliases. The two Mac architectures have separate directories. Update metadata references versioned filenames; it never depends on the convenience aliases.

## Environment and evidence isolation

| Build | Installed name | Deep link | Local evidence on macOS |
|---|---|---|---|
| Development | PackProof Dev | `packproof-dev://` | `~/Library/Application Support/PackProof Dev/EvidenceQueue` |
| Staging | PackProof Staging | `packproof-staging://` | `~/Library/Application Support/PackProof Staging/EvidenceQueue` |
| Production | PackProof | `packproof://` | `~/Library/Application Support/PackProof/EvidenceQueue` |

macOS stores the corresponding application data under `~/Library/Application Support/{installed name}/`. Each environment has a distinct bundle/application ID, protocol and update directory. Account-bound evidence must only be shown or uploaded after the originating account signs in.

The installer updates application files. It does not delete the evidence queue on upgrades or uninstall. This deliberate retention prevents uncommitted evidence loss; uninstall is not an evidence-erasure operation. Use the app's explicit discard/retention controls before removing local evidence.

The [desktop privacy and retention review](docs/privacy.md) maps camera/audio, cached records, original staging, sharing and diagnostics to the implementation. Retention removes eligible media chunks; encrypted queue history and caches persist. The public privacy-policy source includes these distinctions, and publication remains a separate step.

## Security and release behavior

The packaging configuration enables ASAR integrity and disables Electron's RunAsNode, NODE_OPTIONS and CLI inspection fuses in packaged executables. It uses the existing PackProof icon. macOS uses hardened runtime with camera/audio-input usage descriptions and JIT entitlements; it does not request broad filesystem or address-book access.

`desktop-ci.yml` builds clearly labeled development candidates without a verified publisher for Intel Mac and Apple Silicon. Mac candidates have an ad-hoc signature required to run the modified Electron binary on Apple Silicon; they are not Developer ID signed or notarized. A native launch check executes the packaged binary unchanged and requires both main-process startup and a renderer request through the sandboxed preload bridge. It records secure-storage availability separately; it does not sign in or record. It refuses a pre-existing profile and never redirects the user's home directory. These checks do not establish a real camera, real evidence, signed updater or earlier-version database migration test.

`desktop-release.yml` builds signed candidates only after all required environment configuration and credentials exist. It verifies signing team, hardened runtime, notarization, stapling and Gatekeeper on macOS. Signed artifacts can be downloaded for acceptance testing before public promotion.

Public promotion checks the exact source commit, both signed Mac artifact inventories, update hashes and the acceptance record. See [release operations](docs/RELEASING.md) and [acceptance record template](docs/release-acceptance.template.json). A successful compile or CI package is not the definition of production readiness.

## Support and local diagnostics

Use Settings → Diagnostics to copy a redacted operational summary. Never attach shipment recordings, full presigned URLs, tokens or customer metadata to a bug report unless the account owner specifically authorizes that evidence disclosure. When an upload is interrupted, preserve the local application data and sign back into the same account.
