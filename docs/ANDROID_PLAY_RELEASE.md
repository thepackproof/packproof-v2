# Android Google Play release

Google Play Console is the source of truth for application identity and the upload certificate. Do not infer either from an EAS credential marked default, from an EAS application-identifier assignment, or from a previous local `app.config.js` value.

## Canonical Play identity

| Item | Value |
| --- | --- |
| Google Play application / Android package | `com.packproof.mobile` |
| EAS upload credential name | `pdbJYV45vI` (`Build Credentials pdbJYV45vI`) |
| Keystore ID | `2814b1c3-3d11-4225-8ffc-ed8267058434` |
| Required upload SHA1 | `75:25:B4:FC:9A:9D:03:4A:E2:94:92:2A:D4:3D:B1:84:43:D0:E1:4D` |
| Required upload SHA256 | `95:FE:CD:E5:A5:5A:47:36:43:C8:C7:C8:12:E6:94:7F:CB:2A:77:9E:12:28:FD:35:AC:18:C1:39:6F:06:11:5E` |
| Production EAS profile | `production` (Android only; store AAB) |
| Current candidate versionName / versionCode | `1.0.1` / `58` |
| Google account for the release listing | `nericollin@thepackproof.com` |
| Play developer / application ID | `8057861242145257325` / `4976194844927684128` |

`com.thepackproof.app` is a separate draft listing, not this release application. Builds uploaded with that package are rejected by the canonical listing (`Your APK or Android App Bundle needs to have the package name com.packproof.mobile`).

The production baseline was freshly observed as **Available on Google Play**, version `1.0.1 (56)`, at 100% rollout in the existing one-country/region scope on 2026-10-10. Code `57` identifies the previous internal review APK. Code `58` is the next production candidate; this source configuration alone does not establish upload, submission, approval, or live availability.

`production` inherits the established runtime and remote upload credential from `shipping-integration`, enables the mobile task interface, and applies release authentication, HTTPS, source-provenance, and version guards. It does not change any iOS profile or automatically submit to a store. Build with the existing credential frozen (`--freeze-credentials`). The older `internal-staging` and `shipping-integration` profiles remain separate from the current production candidate.

Do not create a new Play application. Do not generate a replacement upload keystore. Do not request an upload-key reset unless the Play Console certificate cannot be recovered from EAS.

## Before every Play upload

Verify all of the following on the **built AAB**, not only on Expo resolved config:

1. Package / application ID is `com.packproof.mobile`.
2. Signing certificate SHA1 is `75:25:B4:FC:9A:9D:03:4A:E2:94:92:2A:D4:3D:B1:84:43:D0:E1:4D`.
3. Provider authorities use the `com.packproof.mobile` namespace, not `com.thepackproof.app`.
4. versionCode is the intended increment; versionName matches the row above unless a later release changes it.
5. The EAS result identifies Android, store distribution, the intended production profile, and the exact reviewed source commit. Check that commit in both packaged configuration and bundled JavaScript.
6. Packaged task-interface metadata is enabled and the internal-review marker is absent. Check the configured API/authentication identity without exposing credentials.
7. Complete the relevant tests and native artifact checks, including manifest/permissions and 16 KB library packaging. Keep static validation and actual device results distinct.

If either the package ID or the upload SHA1 is wrong, do not upload.

Use the existing production track and country/region scope. Preserve other testing drafts. Record the AAB SHA256, EAS build ID, source commit, release notes, console status, and screenshot evidence in a release receipt. Report **uploaded**, **submitted / in review**, and **available on Google Play** separately; only the console's current production status confirms publication.
