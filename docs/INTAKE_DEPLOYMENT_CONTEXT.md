# Mobile intake deployment context

WP0 reconciliation, observed 2026-09-15. This record separates source identity, prior deployment records, current console observations, and unfinished release checks. It is not a claim that this intake candidate is deployed.

## Reconciled source

| Item | Verified value |
| --- | --- |
| Canonical GitHub repository | `thepackproof/packproof-v2` |
| Inspected default branch | `e572b29815ded5f60c7defd0ef138957cecb8d36`; stale relative to tested Android and iOS work |
| Current implementation baseline | GitHub `3b343bc1be160340f52e9ea9e58bfed9d95bdcdf`, developer-access restriction |
| Corresponding clean local commit | `dca1568`, `/workspace/scratch/c652ed669f79/packproof-dev-access` |
| Identical complete source tree | `ef99f21932669932179711ef27ea42ffce21ef21` on both GitHub and local commits |
| Baseline parent on GitHub | `36c972911d04236fcdd85e9cf2f86cf3667682aa` |
| Corresponding local iOS parent | `f634d1a` |
| Identical iOS parent source tree | `8893bc73db628b6398e58627785e1f673232df74` |
| Baseline backend/web/mobile trees | `b74e58e7dd95efb21cf20e3a40f20929f330ac78` / `0c48cf52c36fa98103c7822bbd6f2d7d2038d92a` / `2d6ba0d01053a8b4a261a0d618270e69151ce3bb` |
| Tested Android 49 source | `8e3f2959a4c6288d357e716de28d230c92ac9cd8`, ancestor of the reconciled baseline |

GitHub commits were recreated through its Git-data API with different author timestamps and parent commit identities. Exact Git tree equality establishes source equivalence; the differing commit IDs do not indicate missing source. The old iOS worktree at `/workspace/scratch/8cfeb60dee79/packproof-ios` has a broken `.git` pointer into a deleted checkout and must not be treated as a healthy Git repository. The implementation checkout is isolated at `/workspace/scratch/03a62cc7a006/packproof-intake`.

Repository instructions: root `AGENTS.md` refers to `docs/DEVELOPMENT_PLAN.md` and `docs/architecture.md`; the canonical runtime takes precedence over stale connector-status prose. Preserve canonical transaction ingestion, one Proof per transaction, append-only evidence, finalization guards, and the three-account verified developer allowlist.

## Android distribution observed in Expo and Play

| Item | Current observation |
| --- | --- |
| Application identity | `com.packproof.mobile` |
| Latest serving internal version | `0.3.20` / versionCode `49` |
| EAS build ID for version 49 | `fe7ae1c5-d178-4d0f-b528-aee3334e3a7a` |
| Build 49 source | `8e3f2959a4c6288d357e716de28d230c92ac9cd8` |
| EAS project | `0196c3f7-cb3a-472c-99be-825558f227e8`, owner `packproof-llc`, slug `packproof` |
| Established Android profile | `shipping-integration`, extending `internal-staging`; remote credentials |
| Existing upload credential | `Build Credentials pdbJYV45vI`, keystore ID `2814b1c3-3d11-4225-8ffc-ed8267058434` |
| Recorded upload certificate SHA-1 | `75:25:B4:FC:9A:9D:03:4A:E2:94:92:2A:D4:3D:B1:84:43:D0:E1:4D` |
| Play account/app console IDs | `8057861242145257325` / `4976194844927684128` |
| Play access | Authenticated browser; internal testing serves version 49. Public production release unavailable while closed-testing eligibility remains unmet. |
| Automated Play submission credential | No Google service account configured in EAS; authenticated browser upload remains a separate available path. |

The newer EAS Android build beginning `04535271` used the `ios-simulator` profile for internal distribution. It does not supersede the serving Play version 49 and must not determine the production Android profile. Assign a candidate versionCode greater than the current Play maximum immediately before packaging.

Current Play app-signing SHA-256 fingerprints, as displayed by the authenticated console (distinct from the upload certificate):

- Classical: `6C:E9:6F:2E:DA:2E:11:C0:6A:FC:D3:7A:AD:90:57:41:DA:AC:39:89:CA:53:FD:27:44:26:DC:78:5A:FF:E8:A1`.
- Post-quantum: `C8:37:CC:28:31:56:3F:33:22:3B:51:2E:01:35:64:EE:19:35:70:B3:9D:05:10:C9:AA:BB:24:25:77:19:E4:E9`.
- Historical fingerprint still present in Play's Digital Asset Links snippet: `89:2B:5E:DA:13:2D:76:63:E9:09:A5:E3:05:CE:0C:4F:02:B5:78:E3:05:AF:B0:56:54:33:FD:0D:36:C2:83:01`.

Use the actual distributed app-signing fingerprints for association files and preserve valid rotation history. Verify the final AAB's package, code, source and established upload signer; do not create a replacement key. Physical-device verification is still required after Play processing.

## iOS source, build and access

Host bundle `com.packproof.mobile`; extension bundle `com.packproof.mobile.OrderShare`; App Group `group.com.packproof.mobile.orders`; baseline build number `1`; iOS deployment target `15.1`. Existing profiles select `macos-sequoia-15.6-xcode-26.2`, Node `22.14.0`, Cognito, and the same API as Android.

GitHub iOS run [34841421436](https://github.com/thepackproof/packproof-v2/actions/runs/34841421436), source `36c972911d04236fcdd85e9cf2f86cf3667682aa`, completed successfully on 2026-09-14 at 12:35 UTC. Its app/Swift/Share Extension compile, native project generation and simulator packaging passed. The signed archive job was **skipped**. Simulator artifact `10347935369` is 15,922,376 bytes, with GitHub archive digest `acfc096f7d67e6d5aede91f5b0feb159636409321e9e68ff241b4b16dd886be4`. The artifact name contains the PR merge SHA; the run separately records its source head.

Expo simulator build `0479b7e0-f685-4adc-8dc5-799b6842ad93` also exists at `36c9729`. This is not a signed physical-device IPA. Current Expo credentials UI lists **no iOS identifiers or credentials**, and App Store Connect is signed out. No Apple team ID, provisioning profile, distribution certificate, ASC app ID or physical-iPhone acceptance has been verified. Signed iOS delivery remains blocked on that existing account access; do not invent another team or identifiers.

## API and deployment identity

The verified mobile release profiles target:

`https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws`

Authentication is Cognito, user pool `us-east-1_GdgTeYaOO`, client `34pnucunllka2jcs8hsq762m5e`, region `us-east-1`. These are public application configuration identifiers, not credentials.

Existing infrastructure names are `packproof-v2-staging` (foundation), `packproof-v2-staging-cluster`, `packproof-v2-staging-api` (ECS Express service and ECR repository), and `packproof-v2-staging-web` (web stack). These historical names do not establish isolation from real user traffic: the serving mobile app points at this API.

Prior source-controlled release evidence in `docs/IOS_RELEASE.md` records migration `066_ios_capture_surfaces.sql` applied with 67 migrations current on 2026-09-14. The follow-up deployment reached steady state at 11:56:45 UTC, task definition `packproof-v2-staging-cluster-packproof-v2-staging-api:29`, source `ee6ac3414e9e5cd572ccaba64ef510dfa399e94a`, image digest `sha256:91bd7b9fd6adcc641cf46075c92889912989e4154f7fd7ccf4642e4f781900b5`, backend tree `4fa0d83120a03e518f1d23fa1b8b5c2718a3242f`. This is **prior recorded evidence**, not a current control-plane observation. The later developer-access release may have advanced the live service.

On 2026-09-15 the AWS connector `run_script` request for STS caller identity and ECS `list_services` did not return an API result: it was aborted after a 667-second wait. Consequently the current AWS account, caller permissions, active task/image, environment flags, secret references, worker state and migration count have not been confirmed during WP0. No AWS mutation was attempted. Do not present the prior task definition as the current rollback target until it is read again.

## Existing deployment mechanisms and credential references

- `infra/deploy-staging-current.ps1` reads foundation/web outputs and the existing Express configuration, preserves current web origins and enabled eBay configuration, then invokes the current-commit build/deployment path. `infra/deploy.ps1` requires `ReviewedReleaseSha` equal to HEAD and uses `Merge-ContainerRuntime` in `infra/deployment-helpers.ps1` to preserve optional runtime settings and secret bindings.
- Database migrations are checksummed SQL under `backend/migrations`. Use the controlled `npm --prefix backend run migrate` or built `migrate:prod` command. Startup migration policy must retain the existing disabled setting. Read the current task/secret references and use the established task network/roles for a one-shot migration; never reset the database.
- Database credential reference comes from the foundation `DatabaseSecretArn`; notification secret reference from `NotificationSecretArn`. eBay uses existing `PACKPROOF_EBAY_APP_CREDENTIAL_REFERENCE`. Read only the references needed for deployment, preserve their bindings, and never print secret values.
- GitHub signed-build workflows refer to `EXPO_TOKEN`. EAS stores the established Android keystore remotely. Presence of a workflow secret is not established by a previous successful simulator build.
- Push transport is Expo notifications, with Android Google services/APNs configuration required for the corresponding platform. Queue delivery and correctness must not depend on push.

## Candidate deployment gate and rollback

Before API mutation: record the tested candidate SHA; re-read the current AWS account, service ARN, task definition and image digest; obtain the exact current environment/secret-name mapping without disclosing secret values; inspect existing migration status and recovery measure. Retain that concrete state as the rollback target.

Build from the candidate using the existing pipeline, apply only the additive intake migration with the controlled migration command, preserve existing settings and secret references, and keep new intake/provider rollout flags disabled. Deploy the same candidate image, verify actual running SHA/digest and worker heartbeat, then enable only the internal cohort after durable-intake/authorization/old-client checks. Publish web associations and fallback routes through the existing site's deployment identity.

Rollback disables new intake/provider automation first, preserving existing Proof reads, recording recovery, uploads and additive schema. Revert code/image/config only to the freshly recorded predecessor; do not roll back or delete evidence tables. Signed Android and iOS releases have independent gates. Internal Play availability, public production availability, signed IPA upload and TestFlight availability are distinct statuses.

Remaining verification: current AWS control-plane identity; candidate flags and worker deployment; concrete migration/backup receipt; provider seller scopes and actual sync success; live association-file response; final signed Android package and physical-device journey; Apple credentials, signed archive/processing, and physical iPhone journey. See `INTAKE_SOURCE_SUPPORT.md` for source-app capability limits.
