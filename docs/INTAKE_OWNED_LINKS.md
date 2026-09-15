# Intake owned links and web delivery

The existing web workspace, canonical Proof viewer, server intake boundary and Sites worker are reused. No camera starts and no capture handoff is consumed by a web GET, redirect, association fetch or link preview.

| HTTPS path | Signed-out behavior | Signed-in web behavior |
| --- | --- | --- |
| `/app/packing` or `/app/proofs` | Sign in, then authorized Needs attention | Existing packing queue |
| `/app/proofs/<opaque-proof-id>` | Keep the locator through sign-in | Existing canonical participant Proof fetch and authorization |
| `/app/capture/<opaque-handoff-id>` | Sign in, with account/installation recovery information | Read-only handoff landing; explicit continuation to authorized packing queue |
| `/p/<existing-share-token>` | Existing public evidence-sharing behavior | Existing public evidence-sharing behavior |

Owned app links accept only opaque alphanumeric/underscore/hyphen path identifiers. Query strings and fragments are discarded before routing. Invalid paths fall back to the authorized queue. They do not carry raw orders, OAuth tokens, buyer information or capture capabilities. The current `/capture#intent=...` flow remains a legacy compatibility route; do not issue new intake handoffs in that format.

An installed native app resolves its own paired pending handoffs through the existing authenticated API. In the browser, a handoff link never steals that device's claim. If an app is absent, installation is followed by normal sign-in and queue recovery; no deferred deep-link restoration is promised. Public sharing remains separate from authenticated capture.

## Web paste

The existing **Paste order or receipt** action checks `/me/intake/capabilities`. When `submissionEnabled` is true it submits `EXPLICIT_PASTE` envelopes to `/me/intake/submissions`. The same client UUID is reused for transport retries of an unchanged input. The server chooses canonical identity, candidates and allowed next action. Exact matches open the existing Proof only after the user taps **Open order**. Candidate selection posts only the server-issued candidate ID. Manual confirmation uses the same saved submission's `/resolve` route.

Raw input is kept only in component memory until acknowledged, then cleared. A session-storage receipt contains only the opaque submission ID, partitioned by API scope and actor. Reopening the paste panel reads that receipt through the authorized server endpoint. Old servers and disabled cohorts keep the established explicit manual-preview path. No clipboard monitoring was added.

## Association publication

The Android source association was generated on September 15, 2026 from the actual PackProof Play Console App signing page, inspected in the authenticated console at [App signing](https://play.google.com/console/u/0/developers/8057861242145257325/app/4976194844927684128/keymanagement). It includes the in-use classical signing certificate (`6C:E9:6F:2E:DA:2E:11:C0:6A:FC:D3:7A:AD:90:57:41:DA:AC:39:89:CA:53:FD:27:44:26:DC:78:5A:FF:E8:A1`), in-use PQ certificate (`C8:37:CC:28:31:56:3F:33:22:3B:51:2E:01:35:64:EE:19:35:70:B3:9D:05:10:C9:AA:BB:24:25:77:19:E4:E9`) and historical signing certificate included in Play's Digital Asset Links snippet (`89:2B:5E:DA:13:2D:76:63:E9:09:A5:E3:05:CE:0C:4F:02:B5:78:E3:05:AF:B0:56:54:33:FD:0D:36:C2:83:01`). The upload certificate beginning `95:FE` is intentionally not used. Actual publication and installed-app verification are separate release checks.

Initial attempts to inspect the live association URLs from this execution environment were blocked (HTTP 403 from direct HTTPS; browser access also blocked). This does **not** establish that the remote files are missing. The reconciled repository had no association documents. Preserve any additional entries discovered in the active Sites deployment artifact or a later successful authorized read before publication; the generator's merge behavior is covered by tests. No Apple AASA is fabricated while the signed host application identifier remains unavailable.

`web/scripts/app-associations.mjs` reads package and bundle identity from current `mobile/app.config.js`. It requires actual release signing identifiers and merges existing documents without deleting other applications, services or authorized Android certificate rotations. It validates every requested platform before writing files. Android and iOS can be generated independently.

Environment references (public identities, not private keys):

- `PACKPROOF_PLAY_APP_SIGNING_SHA256`: comma-separated SHA-256 fingerprints copied from the **App signing key certificate** section of the actual Play application, including required authorized rotations. The repository's AAB upload-certificate fingerprint is not sufficient.
- `PACKPROOF_APPLE_APPLICATION_IDENTIFIER`: exact `application-identifier` entitlement of the signed containing app, matching its bundle ID. Do not invent a Team ID or confuse the Share Extension's application identifier with the host app's identity.

After resolving the appropriate real identity:

```sh
npm --prefix web run links:generate -- --platform android
# Independently, once Apple's signed host identity is established:
npm --prefix web run links:generate -- --platform ios
```

Generated files go to `web/public/.well-known/assetlinks.json` and `web/public/.well-known/apple-app-site-association`. Apple associations are restricted to the paths in the table, with no marketing-site or public-share wildcard. If a preexisting production association contains additional valid entries, retrieve and reconcile it into the corresponding source file before regeneration; do not replace an unknown remote document blindly.

`PACKPROOF_LINK_PLATFORMS=android`, `ios` or `all` makes the existing Sites build generate and validate the selected release associations before bundling. Missing signing identity fails that declared link release. Ordinary web-only builds preserve already tracked association files.

The Sites worker serves both documents as direct HTTP 200 `application/json` on apex and www before the normal canonical-host redirect. It also supports `/apple-app-site-association` as a direct alias. Missing, redirected or invalid JSON returns 404, never SPA HTML. Cache lifetime is five minutes. Handoff pages send `Referrer-Policy: no-referrer`.

After publishing the real files and worker through the existing pipeline:

```sh
npm --prefix web run links:verify -- --platform android
# Run the iOS gate only when that platform's actual identity is available.
npm --prefix web run links:verify -- --platform ios
```

The verifier checks direct HTTPS responses on both declared hostnames, JSON MIME type, size, current signing identity and expected scoped Apple paths. It rejects redirects and bot-challenge/HTML responses. Then verify one external link tap on an installed Play-distributed Android build and one on the signed iOS candidate; neither local tests nor association responses substitute for installed-OS verification.

Do not ship the iOS verified-link claim until the real Apple application identifier and signed native test are available. Do not mark Play verification complete from the upload certificate or an AAB alone.

## Focused validation

`npm --prefix web run test:links` exercises association preservation, missing-identity failure, per-platform generation, worker routing/no-redirect behavior and read-only preview handling. Focused Vitest cases cover route sanitization/public-sharing separation, explicit fallback action, repeated submission identity, candidate selection and account-partitioned receipt restore. `npm --prefix web run build` verifies TypeScript and the production browser bundle.

Official references checked September 15, 2026: [Apple associated domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains), [Apple Universal Links](https://developer.apple.com/library/archive/documentation/General/Conceptual/AppSearch/UniversalLinks.html), [Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756?hl=en), [Expo iOS Universal Links](https://docs.expo.dev/linking/ios-universal-links/).
