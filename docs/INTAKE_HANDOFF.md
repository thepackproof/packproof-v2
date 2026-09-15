# PackProof mobile intake — implementation and deployment handoff

**Status recorded September 15, 2026:** Android 0.3.21 (50) is available to internal Play testers. The iOS app and extension passed an actual Xcode compile, but signed iOS distribution is unavailable. Backend and website rollout completed successfully. New intake admission and provider automation remain off. Physical-device and real marketplace sharing checks have not been run; this is not a declaration that the complete plan has passed production qualification.

## Source and delivered scope

[PR #45](https://github.com/thepackproof/packproof-v2/pull/45) merged into `main` as `656d86ad1d892a54ceac5cb569b5e9f3f1b9603a` and includes the reconciled live baseline, preserving Android 49, existing iOS parity and the three-account developer restriction. GitHub baseline `3b343bc` and local `dca1568` have the same complete source tree; implementation did not start from the stale default-branch snapshot in the plan.

| Source | Identity |
| --- | --- |
| Core implementation | `272351488a6efcdd1c95a8e3f8ca007d57fe9fbc`; published prerelease tag `v0.3.21-intake.50` |
| Qualification/release tooling | `9da8e87a42b89fae97d580e46835d427387296ff`; application/runtime code unchanged from core |
| Schema compatibility bridge | `f386b4b381aba9a1489b32e967fa86d8b25c6e7e` |
| Saved web source | `a3d94d50ada1ec98b9cdf4fed5c0525df8dd75ff`; complete tree `3267e4be5ec4f0f20f109f95ff6bf4232fbbafbc` |

The release extends the existing canonical transaction/Proof services with durable, actor-scoped intake submissions; authorized order resolution and candidate selection; revocable intake-only sessions; commerce synchronization checkpoints and retries; and independent provider rollout controls. Android receives text into a private durable inbox before routing an opaque ID. iOS uses a protected App Group outbox and dedicated shared Keychain session. Both clients preserve pending input through login/restart, require assignment of signed-out shares, defer navigation during capture/attestation, and retain one canonical Proof per transaction.

The shared client adds explicit paste, receipt-bound manual drafts, account-partitioned queue caching, foreground recovery and clear local/server delivery states. Existing capture, hashing, upload/commit, attestation and finalization remain the evidence boundary. Owned-domain routes and safe web fallbacks use authenticated opaque locators. No desktop extension, OCR, new camera engine or evidence tier was added.

Principal changes: `backend/src/intake/`, existing commerce worker/adapters/router, `mobile/src/intake/`, existing root/auth/navigation hooks, `mobile/modules/packproof-order-share/`, native config plugins, web intake/link handling, and release workflows. Additive migrations are `067_mobile_intake_submissions.sql` and `068_commerce_sync_checkpoints.sql`. [The work-package map](INTAKE_EXECUTION.md) and [baseline record](INTAKE_DEPLOYMENT_CONTEXT.md) provide the detailed file and environment mapping.

## Artifacts and distribution

| Platform | Verified result | Remaining boundary |
| --- | --- | --- |
| Android | EAS build `07b4ca6d-a2f7-4e61-8727-8f2c123aa1c5` **FINISHED**; package `com.packproof.mobile`, version `0.3.21`, code `50` | Physical installation, share/recovery, App Links and complete evidence journey **NOT RUN** |
| Play internal testing | Track `4699046103976889476`, release `31`: **AVAILABLE TO INTERNAL TESTERS**; [tester join link](https://play.google.com/apps/internaltest/4699046103976889476) | Existing two tester lists/five members preserved; public release is a separate eligibility/review process |
| iOS | [GitHub run 34936353806](https://github.com/thepackproof/packproof-v2/actions/runs/34936353806): actual Xcode app/extension compile **PASS**; simulator artifact `10384037419`, **16,040,115 bytes** | Signed archive job **SKIPPED**; Apple signing credentials absent; TestFlight **NOT AVAILABLE**; physical tests **NOT RUN** |
| Web | **247 application tests + 11 worker checks PASS**; version `26` **PUBLISHED** at 13:18:42 UTC; Android association JSON verified directly on apex and www | Installed-app link journeys **NOT RUN**; Apple association identity/signing remain unavailable |

Android artifact: **`PackProof-0.3.21-50.aab`**, **46,275,467 bytes**. SHA-256:

`d976a92e61b94990d9e1d59dfc1c3bb7bddd4aa51e7692e0fd0fa958887326f9`

The established upload signer is preserved. Certificate SHA-256:

`95:FE:CD:E5:A5:5A:47:36:43:C8:C7:C8:12:E6:94:7F:CB:2A:77:9E:12:28:FD:35:AC:18:C1:39:6F:06:11:5E`

This upload certificate is distinct from Play App Signing certificates used for verified links. The AAB is a Play distribution artifact, not a directly installable APK. Simulator packaging is not a signed physical-device IPA.

GitHub Actions Android automation currently lacks `EXPO_TOKEN`: post-merge run `34972376993` stopped at its explicit credential gate. The separately completed, signed EAS artifact and processed internal Play release above remain available. Future unattended GitHub builds require an authorized Expo automation credential.

Saved Sites version identity: `appgprj_6a9c2365007c8191a0958c54e4a67b95~appgver_8a9c80ffc5608191bfb5dc066d243fb6`. Archive SHA-256: `a02d08fc34d749dfeece84abd3726a40ba9fef7d593b7a35bac948746f024c1f`.

## Backend deployment and release gates

Target: AWS account `784514617543`, `us-east-1`, existing service `packproof-v2-staging-api` in `packproof-v2-staging-cluster`. Despite its historical “staging” name, this API serves the current mobile application:

`https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws`

Candidate image build 76 succeeded; its exact execution ID is in the preflight receipt. Image digest:

`sha256:3f6250adec57a5be4420effcc3cd06b87b2acba8263e748a88c89c91583d7f22`

The compatibility bridge completed at 13:02:34 UTC. Controlled migration task `8a7c2d635fdb4487bda9b483604e40e3` then exited **0** after applying migrations 067/068 with exact executed-byte checksums. The ledger contains **69 migrations**; all three new tables retain the existing `packproof` owner. The separate temporary login was removed, and bridge readiness remained **200** after migration. The runner checked runtime DML access and unchanged durability policy. Evidence: [bridge](intake-deployment-2026-09-15/bridge-release.json), [migration](intake-deployment-2026-09-15/migration-release.json), [preflight](intake-deployment-2026-09-15/image-and-database-preflight.json) and [authority probe](intake-deployment-2026-09-15/migration-authority-probe.json).

| Gate | Evidence/status |
| --- | --- |
| Source reconciliation and existing release identity | **PASS**; exact baseline tree equivalence recorded |
| Backend core CI | Backend job `104275584272` in [run 34936542926](https://github.com/thepackproof/packproof-v2/actions/runs/34936542926) **PASS**; unrelated initial workflow failures were fixed subsequently |
| Qualification CI | Full [main run 34972377014](https://github.com/thepackproof/packproof-v2/actions/runs/34972377014) on merge `656d86a` **PASS**, completed 13:16:42 UTC: backend, web, mobile, Android, PostgreSQL, deployment scripts, source security and all dependency audits. Full head run `34972127900`, separate CodeQL and Infrastructure also **PASS** |
| Mobile contract, recovery and release checks | Typecheck **PASS**; focused intake **12/12**, native plugin **6/6**, redesign **19/19**; stale back-navigation assertion corrected in qualification commit |
| Android native compilation and internal distribution | **PASS**, finished EAS artifact and processed Play release above; separate qualification CI native compile and debug assembly also passed |
| iOS app/extension native compilation | **PASS**; signing, physical-camera validation and TestFlight remain unqualified |
| Compatibility bridge and migrations 067/068 | **PASS**; bridge rollout complete, migration task exited 0 with exact checksums and temporary login removal |
| Final API image and worker heartbeat | **PASS**; deployment revision `7438278713583910603`, task definition `:32`, completed 13:18:05 UTC with exact candidate digest and 100% traffic. All 10 workers healthy; read-only verification task `a87059a63d884b9a9d8dd719ea973ee3` exited 0 |
| Web publication and installed-app association validation | Publication **PASS**; Android association **200 JSON, no redirects** with actual Play certificates on both owned domains. External taps on distributed builds **NOT RUN** |
| Real authorized provider order, retry/queue convergence and existing-client live smoke | **NOT RUN** for this rollout; synthetic tests are not a production seller read |
| Physical share, signed-out/offline restart, account switch, capture→upload→attest→view/share | **NOT RUN** on either OS |

**Backend terminal evidence:** [candidate deployment](intake-deployment-2026-09-15/candidate-release.json) includes actual running image/task identity, public readiness/authentication/CORS checks, worker heartbeat, no temporary roles, all 12 runtime DML checks, unchanged durability policy and aggregate connection state. The existing process runs API and jobs together. Website version `26` deployment `appgdep_6aa945a9cfb481918b1bef879be32d8f` **SUCCEEDED** at 13:18:42 UTC. The public audience and custom domains were preserved. [The site receipt](intake-deployment-2026-09-15/site-release.json) records exact source/archive identity and live HTTP verification. Published URL: https://packproof-experience.packproof.chatgpt.site (owned domain https://thepackproof.com).

## Enabled support, rollout and rollback

The plan's physical acceptance gates remain distinct from compilation and automated regression results:

| Plan gates | Recorded qualification |
| --- | --- |
| G1–G5 identity, authorization, resolution, input and backend jobs | Automated contract/resolver/commerce, recovery and PostgreSQL checks passed on the immutable sources above; no live provider acceptance is inferred |
| G6 Android native boundary | Signed artifact and native compilation passed; primary/lower-memory phone share, offline restart and capture-deferral journeys **NOT RUN** |
| G7 iOS native boundary | Host/extension compiled; signed iPhone online/offline, expired-session and account-switch journeys **NOT RUN** |
| G8 real source/provider | Payload inspection and authorized live order import **NOT RUN**; no automatic provider enabled |
| G9 links/signing | Android artifact upload certificate verified and Play release processed; installed-app external taps **NOT RUN**. Apple Team ID, signed entitlements and TestFlight unavailable |
| G10 evidence regression | Existing API, Proof-record, recovery and finalization automated guards passed; complete physical capture-to-shared-Proof journey **NOT RUN** on either OS |
| G11 changed presentation | Shared component/navigation tests passed; physical large-text, screen-reader focus and dark/light intake review **NOT RUN** |
| G12 deployment recovery | Exact artifact/source identity, additive migration and bridge rollback evidence are recorded in the deployment receipts; authenticated existing-client live smoke remains **NOT RUN** |

`PACKPROOF_INTAKE_ENABLED=false`; `PACKPROOF_COMMERCE_AUTOMATION_PROVIDERS` remains empty. **Automatic commerce polling is disabled for every provider, including previously opted-in connections.** Stored opt-in preferences, cursors and records are preserved; existing manual sync remains available outside this switch. Existing live eBay is disabled with an empty RuName; credential references alone do not establish production authorization. Existing Proofs and upload recovery remain available. Enable only explicit internal actor IDs after live acceptance checks, then qualify each provider and OS independently.

The final read-only connection snapshot found one **disabled sandbox eBay connection with automation off**, no Shopify/Etsy connections, and **zero active opted-in connections paused by this allowlist**. This establishes the observed configuration impact; it does not establish a successful live provider read.

| Source-app combination | Actual native order payload | Current support claim |
| --- | --- | --- |
| eBay / Shopify / Etsy on Android | **Unknown**; app version, Share availability and payload not observed | Text/link reception implemented; advertised native order-sharing journeys unverified |
| eBay / Shopify / Etsy on iOS | **Unknown**, with signed extension/device testing also pending | Extension compiled; no TestFlight or verified source-app claim |
| Android browser / iOS Safari | Real seller payload **not observed** | Bounded text/URL contract implemented; no private-queue or DOM-reading capability implied |

See [INTAKE_SOURCE_SUPPORT.md](INTAKE_SOURCE_SUPPORT.md) for per-provider rows and required redacted observations. If a source app lacks useful sharing, use independently authorized server sync or explicit order entry. A listing, barcode or marketplace username never authorizes another account or proves packing occurred.

For rollback, disable new intake/provider automation first and preserve existing reads, recordings, uploads and additive schema. **After migrations 067/068, use the verified compatibility bridge derived from `f386b4b3`, not the old task-definition `:30` image.** The old runtime rejects unknown migration ledger entries. Keep the bridge’s exact successful image and deployment receipt before migrating; do not delete migration rows, drop tables or reset evidence to make an older binary start. Roll back code/configuration only, and keep Android and iOS release decisions independent.
