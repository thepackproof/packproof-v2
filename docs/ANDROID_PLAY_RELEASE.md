# Android Play Internal Testing release

Google Play Console is the source of truth for application identity and the upload certificate. Do not infer either from an EAS credential marked default, from an EAS application-identifier assignment, or from a previous local `app.config.js` value.

## Canonical Play identity

| Item | Value |
| --- | --- |
| Google Play application / Android package | `com.packproof.mobile` |
| EAS upload credential name | `pdbJYV45vI` (`Build Credentials pdbJYV45vI`) |
| Keystore ID | `2814b1c3-3d11-4225-8ffc-ed8267058434` |
| Required upload SHA1 | `75:25:B4:FC:9A:9D:03:4A:E2:94:92:2A:D4:3D:B1:84:43:D0:E1:4D` |
| EAS profile | `internal-staging` |
| versionName | `0.2.0` |

`com.thepackproof.app` is not the Internal Testing listing. Builds uploaded with that package are rejected by Play (`Your APK or Android App Bundle needs to have the package name com.packproof.mobile`).

Do not create a new Play application. Do not generate a replacement upload keystore. Do not request an upload-key reset unless the Play Console certificate cannot be recovered from EAS.

## Before every Play upload

Verify all of the following on the **built AAB**, not only on Expo resolved config:

1. Package / application ID is `com.packproof.mobile`.
2. Signing certificate SHA1 is `75:25:B4:FC:9A:9D:03:4A:E2:94:92:2A:D4:3D:B1:84:43:D0:E1:4D`.
3. Provider authorities use the `com.packproof.mobile` namespace, not `com.thepackproof.app`.
4. versionCode is the intended increment; versionName matches the row above unless a later release changes it.

If either the package ID or the upload SHA1 is wrong, do not upload.
