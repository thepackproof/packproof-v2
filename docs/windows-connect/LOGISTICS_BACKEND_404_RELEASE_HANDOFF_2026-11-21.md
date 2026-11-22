# PackProof Logistics API deployment — verified state and release handoff (2026-11-21)

**Checkpoint: 2026-11-22, 01:43 UTC; backend final verification: 00:02:37 UTC.** The backend release is complete: migrations 125–129 were committed and independently verified, and the candidate is deployed as API revision 64 and worker revision 13. The native API deployment is `SUCCESSFUL` at 100% traffic, with independent service, image, source, topology and public-readiness checks passed. PR #184 has merged, and the exact main Windows source `70868ed5d6176d8eef7aeaccee22a62d63f706b1` passed its own source CI, packaged visual review and all five Windows qualification jobs. The active Logistics release line has incorporated that source with verified read-back. The delivered installer is an unsigned development build for internal use. **Actual Windows 11/customer-device acceptance and authorized facility binding remain outstanding.** Guided-facility and assistant allowlists have not been activated.

This handoff records observed release progress. Each remaining phase still requires its own current observations and receipts. The earlier image-build blocker no longer describes the current state: the build was accepted through the normal AWS connector and completed successfully. Times below are UTC on 2026-11-21 unless a different date is stated.

## User-visible incident and separate access conditions

Before the backend rollout, the qualified unified Windows 0.7.0 build displayed `PackProof request failed (404)` at Logistics entry after sign-in. `desktop/src/main/api.ts` calls `GET /me/records/agent-installations/{installationId}/workspace-access?organizationId=…&environment=…`. The endpoint exists in the qualified backend source, but was absent from the originally deployed backend; the verified candidate deployment now includes it.

An installation that is missing, revoked, outside the current human's authority, or ineligible for guided facility setup can independently receive 404 from this endpoint. A null location also cannot satisfy the facility allowlist. Deploying the endpoint therefore addresses only the missing-route cause; it does not establish installation or facility eligibility.

The unified client's former entry guard also blocked authorized recovery when native revoked status correctly omitted its old binding. The client-only bootstrap/recovery correction is implemented and merged in PR #184, using existing human-admin endpoints. It does not change backend or portal authorization rules.

## Immutable source and images

The backend application source remains pinned independently of later operator-tooling or client changes.

| Evidence | Verified value |
|---|---|
| Qualified backend source | [`617a58b883328ad04513a48564d33c573b9b7c78`](https://github.com/thepackproof/packproof-v2/commit/617a58b883328ad04513a48564d33c573b9b7c78) |
| Main-branch CI for that source | [CI run 44836162295](https://github.com/thepackproof/packproof-v2/actions/runs/44836162295) — passed |
| Original qualified Windows build and clean-install/upgrade checks | [Windows run 44836162283](https://github.com/thepackproof/packproof-v2/actions/runs/44836162283) — passed; distinct from backend CI |
| Source archive SHA-256 | `ad0de3976803f245a07c10ce12b9567763c2b8c52f2640ec5c9f8c3fd064b5aa` |
| Archive inventory | 1,046 source Git blobs and 128 migration entries, generated and independently re-verified from pinned Git blobs |
| Exact through-124 ledger SHA-256 | `d0161362a548b61f4cc69195ad8920fbddec36f2b9d183e5b1cd066b6f0eeb60` — 123 migration entries |
| Exact through-129 ledger SHA-256 | `8ab67cf9cc721d6da4c28cef72fdcdaf2b08faaa86196d76acff0a4f95f97fcc` — 128 migration entries |
| Candidate image digest | `sha256:1efe5d4761918809195351d8ce56bdf023532975a7cb641ab72133ce20ec4961` |
| Compatible fallback image digest | `sha256:ace6fb54768e02f3acfc02f8345c92a35e6999cde3a527af346b44581bdebed8` |
| Original predecessor image digest | `sha256:0eb281d47f59d172b28273d6f64a211a7a5a808fae3f7bd715c409dc799de619` |

The successful build used the exact reviewed, version-pinned archive through `prepareLogisticsImages` in `infra/backend-release/logistics-image-builds.mjs`. Verification bound the successful build's own publication log to the live ECR digests. Manifest-bound image configurations and labels were independently checked against the source, archive and predecessor pins. The private staged object location, object version and complete build receipts remain in the operator evidence bundle.

## Runtime tooling and fallback deployment completed

[PR #183](https://github.com/thepackproof/packproof-v2/pull/183) added the runtime qualification/promotion tools and metadata-only facility inspection. Its exact head, `3c2b49942109d8e9253a5d69ed5c73e2b7c6f74e`, passed CI, image qualification, Infrastructure, Records contract/SDK and CodeQL workflows before merging into `main` as `6b1c5396a4482662365aa28af0543c9b063c7e5b`.

The runtime route is documented in [`infra/backend-release/LOGISTICS_RUNTIME_ROLLOUT.md`](../../infra/backend-release/LOGISTICS_RUNTIME_ROLLOUT.md). Its frozen probe source SHA-256 is `4d482bca32e27a273c583186d7ca8b0dc8a8ef467b7d3118ce4edb255d317661`.

Four distinct real ECS probes qualified the fallback and its predecessor on the actual through-124 database: fallback API, fallback worker, predecessor API and predecessor worker. Every task stopped with exit code 0. The probes used the established API and worker database logins, verified TLS and role separation, and checked the frozen ledger, source guards, immutable history and full through-124 privilege policy. Worker probes exercised permitted import readers while verifying that API-owned order history remained inaccessible to the worker. No worker privilege expansion was used to satisfy qualification.

The fallback was then promoted worker first and API second. The independent observation at **23:28:55 UTC** recorded:

| Runtime | Observed fallback revision | Outcome |
|---|---|---|
| Worker | `packproof-records-production-worker:12` | Stable on the immutable fallback digest |
| API | `packproof-v2-staging-cluster-packproof-v2-staging-api:63` | Native deployment `SUCCESSFUL`, stable on the immutable fallback digest |
| Public checks | `/health` 200; `/ready` 200; unauthenticated `/me/capabilities` 401 | Health/readiness available and authenticated route still protected |

The service names contain `staging`, but these are the services handling the live PackProof environment. Existing runtime configuration, service roles, worker initializer and temporary volume were preserved. The API's existing order-workspace setting was retained; runtime promotion does not activate guided-facility or assistant allowlists.

## Owner migration committed and independently verified

The owner rehearsal completed at **23:29:52 UTC** with review SHA-256 `ba5b6eb336ed2db25804ce009814792c2888f554ae60b4544056c1414addad34`.

It exercised the exact migrations 125–129, verified the resulting through-129 inventory, and planned/applied 46 ACL statements limited to the seven reviewed changed tables inside the rehearsal transaction. Its receipt explicitly reports `rolledBack: true`. This was a successful rehearsal, not a committed migration.

The separately reviewed apply committed at **23:32:48.597 UTC**, and its task stopped with exit code 0. It applied the same 46 reviewed ACL statements and reported policy SHA-256 `cac9229b149d189a5e9886a8e73078c5bcbbbb456f00804f55ce5fae07abd4c9`.

A distinct owner inspection completed at **23:35:25.358 UTC**, verified the exact through-129 ledger and recorded zero writes. The four distinct tasks—initial inspection, rolled-back rehearsal, committed apply and post-apply inspection—passed `verifyLogisticsApplication`, producing a `packproof.hosted-logistics-migration-verified/v1` result. The historical ledger and its existing receipts were preserved.

After apply, public checks at **23:34:32 UTC** still returned `/health` 200, `/ready` 200 and unauthenticated `/me/capabilities` 401 while both services remained on the fallback.

## Compatibility boundary and completed candidate promotion

The fallback preserves the predecessor application's layers and startup configuration while adding an exact five-migration forward-reader envelope. Image qualification checked the compiled schema reader against the pinned 124 and 129 ledgers, including rejection of altered or unknown migrations. It did not represent a synthetic ledger check as a live application boot on 129.

The old full through-124 records catalogue cannot validate the expanded 129 columns. Normal fallback startup does not invoke that obsolete catalogue. For qualification on the actual 129 database, the runtime planner deliberately requires fallback reader/authority checks paired with candidate **full through-129 privilege verification under both actual database logins**. Neither image's receipt substitutes for the other's required checks.

All four distinct candidate/fallback probes completed between **23:36:51 and 23:37:04 UTC**, with actual stopped-task exit codes of 0. The candidate passed full through-129 privilege verification under both actual runtime logins, paired with the fallback's separate reader/authority checks under those same role boundaries.

A candidate promotion plan was prepared at **23:37:49.101 UTC**. The worker service was updated to candidate revision 13 first; a fresh complete observation at **23:48:10 UTC** verified its completed singleton deployment and actual candidate image digest before the API change. The API update was accepted at **23:51:38.535 UTC**, within the plan's 15-minute request-validation window, using the unchanged reviewed request constructor and exact prepared primary-container configuration.

Intermittent execution-connector `UNAVAILABLE` errors interrupted control-plane requests; these were transport failures, not approval denials or observed service failures. After an ambiguous update response, fresh read-only Express configuration and native-deployment observations established that no candidate API update had occurred. The exact unchanged request was revalidated and accepted before expiration. No review timestamp or validity gate was extended.

The native API canary reached 5%, completed its monitored interval, then reached 100% traffic and completed its bake/cleanup phases. At **2026-11-22 00:01:44 UTC**, native deployment status was `SUCCESSFUL`, alarm monitoring was complete, and no alarm had triggered.

An independent full observation at **2026-11-22 00:02:01 UTC** succeeded across all 23 required AWS reads. The frozen service verifier and additional exact configuration comparisons passed at **00:02:37 UTC**:

| Final release check | Verified result |
|---|---|
| API | Revision 64; native deployment `SUCCESSFUL`; desired 1, running 1, pending 0 |
| Worker | Revision 13; completed primary deployment; desired 1, running 1, pending 0 |
| Actual running application containers | Exact candidate digest `sha256:1efe5d4761918809195351d8ce56bdf023532975a7cb641ab72133ce20ec4961` |
| Public release identity | `/meta` 200; backend source `617a58b883328ad04513a48564d33c573b9b7c78` and exact candidate digest |
| Fresh public health and authentication boundary | `/health` 200; `/ready` 200; unauthenticated `/me/capabilities` 401 |
| Service configuration | Canonical topology unchanged; API primary-container configuration matches the reviewed request; worker initializer and temporary-volume configuration preserved |
| Feature state | Existing API order-workspace setting remains enabled; guided-facility and assistant activation remain absent |

No additional service or schema mutation was required after successful promotion. The complete operational observations and receipts are retained privately; they are not included in this public handoff.

## Remaining device and facility acceptance

A later metadata-only inspection completed at **2026-11-22 01:35:28 UTC** using the deployed candidate, exact through-129 ledger and actual API database login. The one task stopped with exit code 0; its source/image/task-bound receipt reports `readOnly: true`, `rolledBack: true` and a complete one-installation inventory. The existing acknowledged 0.7.0 sandbox installation remains in `setup` with no assigned location. The organization is enabled, an active administrator membership is recorded, and no renewal is pending. This inspection neither authenticated a new browser session nor changed an account, installation, facility or service. It confirms why explicit facility binding remains necessary after the backend and client repairs.

1. Use the verified internal development installer from Windows source `70868ed5…` for acceptance on the intended Windows 11/customer device. The hosted build, packaged UI and Clean/Upgrade/SameVersion rehearsals are complete; actual Windows 11 NSIS execution and on-device acceptance remain separate.
2. Verify the exact signed-in installation's current administrator authority and its workspace-access response. An absent or revoked binding must use the reviewed explicit recovery/enrollment path; backend route availability does not grant installation authority.
3. Establish the intended authorized organization, environment and nonnull location before any guided-facility activation. Use only the exact reviewed tuple. Never use a wildcard, infer a location from a screenshot, or enable every facility. Assistant activation remains a separate approval and allowlist.
4. Complete unified Windows acceptance on the actual device against the deployed endpoint and authorized account: sign-in, authorized recovery where needed, explicit facility setup, a real known order and its reconstructed Proof. Signed installer publishing remains a separate release step.

Future recovery or rollback still follows the runtime runbook and its fresh evidence requirements. Generic forward resumption from an expired mixed-state plan is not implemented; this completed deployment did not use such a route.

## Client and Commerce corrections — merged source and qualification

[PR #184](https://github.com/thepackproof/packproof-v2/pull/184) merged normally into main as [`70868ed5d6176d8eef7aeaccee22a62d63f706b1`](https://github.com/thepackproof/packproof-v2/commit/70868ed5d6176d8eef7aeaccee22a62d63f706b1), from reviewed PR head `c980b4a7227abb68051ca82f40431498a7eac59d`. This merged main commit is the immutable application source for the qualified delivery installer. Its own Windows run and source CI passed independently of the successful PR checks. The delivery package was built from main and verified against that exact source.

The patch contains no backend runtime or portal changes. Local focused bootstrap validation passed 69 tests and type checks, and independent authorization reviews identified no blocking issue. It uses existing current-human administrator endpoints to identify the same installation, returns only setup metadata, checks account/session changes and separates bootstrap from operational access. Revoked recovery retains the native explicit consent and protected-queue archive process. Bootstrap does not grant Orders, source discovery, draft editing, AI or activation, and does not create an offline facility lease.

The pinned backend and portal remain unchanged. The client explains the need to choose an explicit authorized facility; a null-location browser approval remains incomplete under the full workspace gate. This is not a new server-enforced nonnull enrollment invariant.

### Commerce layout, brand and consent

The repair reuses `web/public/brand/connect/packproof.png` unchanged, Git blob `5224892f4b09263e486751ae3848a92aba7ca560`, matching Figma node `28:1174` and the existing Connect brand. Its implementation remains in the existing Commerce owner and CSS.

The changes improve profile contrast, contain the active navigation marker, align the Home action, keep initial Packing Station controls visible at 125%, group the order date fields, separate filter controls and Help subsections, and place workstation preferences before the complete optional study statement. Updater actions now match the actual available/ready states. The ungranted consent checkbox remains unchecked and explicit; existing consent is not reset. No source approval, collection, withdrawal or evidence-retention semantics changed.

The additive [Windows implementation-contract section](../WINDOWS_UX_IMPLEMENTATION_CONTRACT.md#commerce-regression-acceptance--authorized-repair-2026-11-21-eastern) requires actual unified Commerce Home, Packing Station, Orders and Settings evidence in both light/dark appearance at 100%/125%, including the complete study statement. These checks supplement all existing Logistics and functional requirements.

### PR qualification and the two acceptance-fixture corrections

The final PR [source CI 44970606013](https://github.com/thepackproof/packproof-v2/actions/runs/44970606013) completed successfully, including all backend shards, PostgreSQL release invariants, source/release tooling, dependency audits, Web and Mobile. Desktop checks, Records contract/SDK, native media, Partner gates and CodeQL also passed. Both Mac acceptance jobs encountered the separately documented pre-existing external provenance-verification failure; this Windows work does not claim Mac acceptance.

The final PR [Windows run 44970605930](https://github.com/thepackproof/packproof-v2/actions/runs/44970605930) passed all five jobs: native candidate, unified workstation, Clean, Upgrade and SameVersion. Its actual checkout is `69f71c777a9e68dc27b5a4107106fa0701072394`, distinct from the PR head, merged main and deployed backend source.

The SameVersion rehearsal used the frozen historical 0.7.0 source `617a58b…`. It preserved the installation and approved scope, source generation, spool key and encrypted pending original, then obtained an accepted receipt for that exact retained request and drained its queue within the unchanged 90-second requirement. Commerce recovery and pilot-reversal checks also passed. Earlier failure was traced to the test fixture, not solved by changing native retention behavior:

- A diagnostic using the exact installed bytes showed repeated identical native requests reaching the loopback backend, which returned HTTP 500. A real HTTP reproduction with the lock-resolved Express 4.22.2/body-parser 1.20.9 showed that the fixture's early `req.on('data')` listener drained the request before the real JSON parser across an asynchronous router boundary.
- The minimal fixture-only correction observes data passively through `EventEmitter.prototype.on.call` and explicitly resumes only held requests. Nine real HTTP cases passed, including exact-byte acceptance and preserved rejection outcomes. Its SHA-256 is `e5825b5b4bdd26f1d98d24c5204ae2965ddd38f6b904f6b37c1fa5ab87b9dd05`. No native runtime, retention requirement or timeout changed.

A separate first-entry screenshot from the previous PR checkout repeated the native 1008×655 surface across a nominal 1440×900 PNG. The capture-only correction waits for fonts, visible images, two animation frames and a following task, records native dimensions, and rejects repeated raster surfaces. One bounded recapture is permitted only for that specific detected condition; the rejected original and attempt information are retained, and a second invalid capture or any other assertion fails the gate. Independent checks across 184 real PNGs identified exactly the observed bad frame, accepted the 183 valid frames and two uniform/sparse controls, and passed all four capture-policy cases.

Fresh final-PR artifact `14733627222`, ZIP SHA-256 `68ad46fcafa11c9b6b957631cbb11422b06b9133ba5c4dfa4b35102a45e40a66`, contains 92 actual packaged screenshots. All 35 entry/bootstrap/Commerce captures succeeded on the first attempt with no rejected frame; the first entry is correct and the other 91 PNGs match the already-reviewed capture set. Independent visual review covered the complete Commerce theme/scale matrix and the unchanged Logistics frames. These captures use the packaged unified renderers and production preload with isolated synthetic IPC state; they do not establish live facility authorization.

### Exact main build and release-line continuity

Main [Windows run 44971704715](https://github.com/thepackproof/packproof-v2/actions/runs/44971704715) and [source CI 44971704691](https://github.com/thepackproof/packproof-v2/actions/runs/44971704691) bind to `70868ed5d6176d8eef7aeaccee22a62d63f706b1`. The downloaded package and renderer evidence have been independently verified:

| Main delivery evidence | Verified identity |
|---|---|
| Immutable installer application source | `70868ed5d6176d8eef7aeaccee22a62d63f706b1` |
| Unified package artifact | `14734215978` from Windows run `44971704715` |
| Delivered installer alias | `PackProof-Windows-Development-0.7.0-70868ed5.exe` — byte-identical to original `PackProof-Connect-development-Setup-0.7.0.exe` |
| Installer SHA-256 and size | `bb3ee79ba0d5bacf7936dca6dd7a02dcbc421cfac6924f62c79307f80efd5c60` — 191,302,989 bytes |
| Delivery ZIP | `PackProof-Windows-Development-0.7.0-70868ed5.zip` |
| ZIP SHA-256 and size | `cc78e2686021aff45acaaafffc5981fcbc23f0cc9ce2320d779174f2d6bc5358` — 191,345,472 bytes |
| Exact-main visual artifact | `14734410938`; ZIP SHA-256 `b5b7ef453c6f50e9514fd0955ec0ccedc93855ed9144c990e3b188ecbf8f0394` |

The package provenance and release evidence agree on the clean main source and `unifiedWindows: true`. This is an **unsigned development build for internal delivery**, with public distribution disabled. It is not a signed public release.

The main visual artifact contains all 92 required PNGs. Its 35 entry/bootstrap/Commerce captures succeeded on the first attempt with zero rejected surfaces. The exact-main entry was independently inspected and is correct; the other 91 images are byte-identical to the accepted final PR set.

Main source CI completed successfully at **2026-11-22 01:41:15 UTC**, including all four backend shards, PostgreSQL release invariants, deployment/source tooling, audits, Web/Mobile and Android Kotlin. The separate main Desktop checks, Records contract/SDK, Android production receipt integration, Desktop candidate builds and CodeQL workflows also passed.

Main Windows qualification completed successfully at **2026-11-22 01:40:21 UTC**, with all five jobs passed: native candidate, unified workstation, Clean, Upgrade and SameVersion. The downloaded installation receipts bind both candidate and rehearsal to the same main source. SameVersion preserved the existing installation, approved scope, source generation, protected spool and encrypted pending original, then obtained the accepted receipt and drained the exact retained request within the original 90-second gate. Native qualification also passed the historical encrypted writer, actual LocalService protected storage/bridge, partitioned queue upgrade, unhealthy-installation rejection/retained-storage repair and read-only Windows PowerShell 5.1 diagnostics.

The active `release/logistics-129-pilot` line incorporated the qualified main source through a normal non-force update from `fca846affafdb3d2d534e161a9e82aed4fec04ba` to `70868ed5d6176d8eef7aeaccee22a62d63f706b1`, with the exact prior-head lease. Ancestry verification showed 11 commits ahead and none behind. Independent read-back at **2026-11-22 01:42:18 UTC** confirmed the qualified main source. This handoff records that completed incorporation. Its own documentation-only commit is separate from the immutable installer source; any later documentation-only release head does not relabel the installer bytes.

The automatic installation matrix uses the hosted `windows-2025` runner. Its receipts distinguish the hosted Server installer-payload/service-lifecycle rehearsal from the supported Windows 11 NSIS path, which remains `not_run` unless the separately provisioned disposable Windows 11 runner actually executes it. A successful hosted matrix must not be described as Windows 11 or customer-device acceptance.

Continue to follow [the approved Windows design authority](../APPROVED_WINDOWS_UX_AUTHORITY.md) and implementation contract. Live sign-in, the exact authorized installation and nonnull facility, real known-order reconstruction, customer-device acceptance and signed installer publishing remain separate gates. No guided-facility or assistant activation is implied by a successful build or this handoff.
