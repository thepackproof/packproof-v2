# Connect setup recovery: exact-source 129 → 130 rollout

This release repairs initial facility assignment, saved-review recovery and the
0.7.1 collector admission boundary. The executable route is
`.github/workflows/connect-recovery-release.yml`; it uses the existing
`PackProofGitHubDeploy` OIDC identity, CodeBuild project and ECS services. Every
run performs **one explicitly requested phase**. Publishing this tooling alone
does not deploy anything. The initial request file is deliberately absent.

## Before starting

Merge the reviewed backend, web and release tooling through the normal protected
PR checks. Use the full resulting **main source commit** for every phase. The
workflow obtains that commit's successful `ci.yml` result from GitHub; callers
cannot supply their own CI evidence. Inspection can run before CI completes;
all later phases require successful exact-source main CI, including the
PostgreSQL 16 release-invariants job. Its named suite includes
`backend/tests/connect-recovery-privileges.test.ts`: owner rehearsal rollback,
retained ledger/data, the three narrowly changed API ACLs, worker denial and
idempotent application. A local skipped PostgreSQL case is not that evidence.

Use the existing AWS deployment variable `AWS_DEPLOY_ROLE_ARN`. Do not change
OIDC trust or grant a broader role to make this workflow pass. The first
inspection must actually assume the existing role, confirm account
`784514617543` in `us-east-1`, and read the current fleet and topology. A denied
or incomplete observation stops the release. Historical deployment receipts are
context only; they are not current authorization or runtime observations.

## Trigger and receipts

Commit one reviewed JSON request to
`infra/connect-rollout/recovery-promotion.json` on **main**. A push changing that
path triggers the workflow. Alternatively, the workflow-dispatch `request`
input accepts the same JSON. Updating this file is the explicit decision to run
that phase; do not place later phases in an automatic loop. Release concurrency
is shared with the existing backend release workflow.

Download the `connect-recovery-<phase>-<source>-<run-id>` artifact after each
successful run and inspect its JSON receipts before preparing the next request.
Only redacted receipt files are uploaded. Raw AWS configuration, registered
owner task definitions and secret references stay in the runner's private
temporary directory. Secret **values** are never read by the coordinator.

The first request is exactly this shape, replacing the source placeholder:

```json
{
  "phase": "inspect",
  "source": "<full reviewed main source commit>"
}
```

The optional `owner` field below may be included in inspection to validate the
existing owner launch metadata before any write phase. These are the nonsecret
identifiers from the November 21 receipt; the observer checks their current role,
database, secret-version metadata and network rather than trusting the file:

```json
{
  "executionRoleArn": "arn:aws:iam::784514617543:role/packproof-v2-staging-execution",
  "network": {
    "subnets": ["subnet-0d7611419ad695536", "subnet-002790f4a22ef84ee"],
    "securityGroups": ["sg-0fbfe8871eef85488"],
    "assignPublicIp": "ENABLED"
  }
}
```

All subsequent requests contain `phase`, the same `source`, and `expected`.
Copy `expected` **unchanged** from the current successful `inspection.json`, or
use `fallback.json.pins` after the bridge cutover. It has this exact structure:

```json
{
  "api": {"source": "<40 hex>", "image": "<immutable ECR URI>", "taskDefinition": "<observed ARN>"},
  "worker": {"source": "<40 hex>", "image": "<immutable ECR URI>", "taskDefinition": "<observed ARN>"},
  "topologySha256": "<64 hex>",
  "preservationSha256": "<64 hex>"
}
```

Both current services must share the expected source and image. Every run reads
them again and rejects drift. Image promotion preserves existing service roles,
credentials, initializer, legacy workspace, feature flags and network settings.

### Exact phase schemas and order

| `phase` | Additional required request fields | Successful receipt and next decision |
| --- | --- | --- |
| `inspect` | None; optional `owner` | `inspection.json`: actual current pins and read-only account/topology observation. |
| `facility-inspect` | `expected`, `facility` | `facility-encrypted.json` contains only an encrypted receipt and qualified task/code identity. Decrypt locally to inspect current actor and jointly eligible facility metadata. No service, schema or access change. |
| `build` | `expected` | `images.json`: actual exact-source archive, CodeBuild publication and two immutable images. No service or schema change. |
| `bridge` | `expected`, `build` | `fallback.json`: four actual-role probes, then worker and API running the preserved129 application with the exact130 receipt reader. |
| `rehearse` | Bridge `expected`, `build`, `owner` | `rehearsal.json`: independent owner inspection and successful transaction that rolled back; no committed migration. |
| `apply` | Same bridge `expected`, `build`, `owner`, `ownerReceipts` with inspection/rehearsal | `migration.json`: actual apply plus a separate post-apply inspection; all historical migration receipts retained. |
| `promote` | Same bridge `expected`, `build`, `owner`, complete `ownerReceipts` | `candidate.json`: four fresh actual-role probes against130 and both services running the candidate, with readiness and preservation checks. |

For `bridge` and every later phase, `build` is an object copied from the actual
`images.json` receipt containing these exact fields:

```json
{
  "source": "<same full reviewed main source commit>",
  "archiveSha256": "<actual archive SHA256>",
  "sourceVersion": "<actual S3 object version, not a Git commit>",
  "buildId": "packproof-v2-staging-api:<actual build UUID>",
  "predecessor": "<original immutable129 image URI>",
  "candidate": "<new immutable130 image URI>",
  "fallback": "<new immutable129-compatible image URI>"
}
```

The coordinator re-reads the actual CodeBuild configuration, successful build
log and ECR publication for these pins. A plausible JSON object is insufficient.
The versioned source archive is reconstructed from exact Git blob bytes using
`backend-source-archive.py SOURCE FILE recovery-v1`; modified and untracked
working-directory bytes are excluded. The previous image is retained, and the
bridge only changes its compiled forward-schema reader for this exact130 row.

For `apply`, use `ownerReceipts` copied from the successful `rehearsal.json`:

```json
{
  "reviewSha256": "<actual owner protocol review digest>",
  "inspection": "<actual stopped inspection task ARN>",
  "rehearsal": "<actual stopped rehearsal task ARN>"
}
```

For `promote`, copy **all of** `migration.json.ownerReceipts`; it adds
`confirmation` and `postInspection` task ARNs to the same object. The coordinator
reconstructs the review from the registered rehearsal definition and validates
all four actual stopped tasks and process log receipts. Do not recalculate this
digest with configuration canonicalization, replace timestamps, or substitute a
locally authored report. Owner review expires after 110 minutes; all subsequent
owner verification must complete before expiry. Each runtime cutover has its own
15-minute lease and fresh probes. Expired or changed evidence requires a new
observed review; it must not be edited to appear current.

### Optional read-only facility inspection

After successful control-plane `inspect`, an explicit `facility-inspect` request
can diagnose the current human account and retained computer using the existing
API image. It requires successful main CI for the reviewed inspector source,
but it deliberately preserves the **observed runtime source and image**; an old
image is never relabeled as the inspector's newer tooling commit. The fixed
compressed script is checked against that reviewed Git source and its digest.

```json
{
  "phase": "facility-inspect",
  "source": "<full reviewed main tooling commit with successful CI>",
  "expected": {
    "api": {"source": "<observed40hex>", "image": "<observed immutable ECR URI>", "taskDefinition": "<observed ARN>"},
    "worker": {"source": "<observed40hex>", "image": "<observed immutable ECR URI>", "taskDefinition": "<observed ARN>"},
    "topologySha256": "<copied from inspection>",
    "preservationSha256": "<copied from inspection>"
  },
  "facility": {
    "subjectSha256": "<SHA256 of the exact previously verified Cognito subject UTF-8 bytes>",
    "recipientPublicKeySpki": "<ephemeral X25519 public key DER SPKI, base64>",
    "inventorySha256": "<exact129 or130 ledger SHA256>"
  }
}
```

The accepted ledger hashes are
`8ab67cf9cc721d6da4c28cef72fdcdaf2b08faaa86196d76acff0a4f95f97fcc`
(128 rows through129) and
`13f05713808a4c077b9388d5609d99ad1bfa16b9ded82b2e447bc1c076d5896e`
(129 rows through130). Generate an ephemeral X25519 key locally. Keep its private
key in a mode0600 PKCS8 PEM file outside the repository; only its44-byte DER SPKI
public key (base64,60 characters) enters the reviewed request. Derive the subject
digest locally from the exact verified subject string, with no normalization.
Do not put the subject, a user ID, a workstation name or a private key in Git,
workflow input or logs. Never infer a subject from a workstation name or assume
a historical role/facility assignment is still current. The probe compares
`encode(sha256(convert_to(provider_subject,'UTF8')),'hex')` to that exact digest,
verifies the unique active human identity, uses an API-role read-only transaction, requires
TLS and rolls back before success. It reports at most21 installations and21
eligible locations per installation, with totals and truncation explicit. Every
choice satisfies both the current administrator's and active enrolled operator's
location grants. Guided and assistant availability reflect the actual exact
workspace allowlists and order-workspace flag; the allowlists themselves are
not returned. This observation does not create facilities or grant access.

This phase reuses `verifierTaskDefinition` / `runVerifierRequest`, permits only
the observed API task/execution roles and one verifier family, and cleans up its
own task definition. It cannot update services. The default `inspect` phase
still has no task-launch permission. This repository is public: the inspector
encrypts the entire bounded result **before stdout/CloudWatch**, using ephemeral
X25519 agreement, HKDF-SHA256 and AES-256-GCM. The authenticated header binds the
exact runtime source, image, ledger, task ARN, subject digest, recipient-key
digest, timestamp and encryption parameters. Neither GitHub nor the task gets
the recipient private key. Plaintext account/installation/location metadata is
never uploaded. The historical exact-subject local CLI mode cannot be selected
by this workflow's digest-and-recipient-only request schema.

Download `facility-encrypted.json` from the ordinary release artifact. Verify its
GitHub run/source and task qualification, then use `decryptFacilityReceipt` from
`logistics-facility-inspect.mjs` **locally**, supplying the retained private-key
PEM and expected `{source, image, inventorySha256, actualTask, subjectSha256}`.
Use the observed runtime source/image pins, not the newer tooling source. The
function rejects a different recipient, changed ciphertext/tag/header or any
mismatched identity; it also compares decrypted source/task identity back to the
authenticated header. Save decrypted metadata locally with mode0600 and do not
publish it. The workflow attests execution and envelope bindings; it deliberately
labels inner receipt authentication as requiring the local private key.

## Finish the backend, portal and installed journey together

**`apply` is an intermediate state, not a completed repair.** The compatibility
bridge retains the old application behavior. In particular, after130 ACLs are
committed, that old application can still attempt its former missing-facility
configuration path. Complete the candidate and matching portal promotion before
asking the user to retry setup. Do not claim the issue fixed while only grants
or collector admission have changed.

After `candidate.json` confirms both services, use the existing
`.github/workflows/connect-portal-publish.yml` flow by updating
`infra/connect-rollout/portal-promotion.json`. Its exact schema is:

```json
{
  "portalCommit": "<reviewed main web source commit>",
  "apiCommit": "<same source as candidate.json>",
  "apiImage": "<same immutable image as candidate.json>",
  "previousManifestSha256": "<freshly observed current portal manifest SHA256>"
}
```

`portalCommit` must be the API commit or its descendant with identical backend
runtime inputs. The130 verifier pins the reviewed recovery Dockerfile and owner
CLI as well as all normal runtime inputs. The portal publisher compares the
current manifest, retains the previous release, verifies the exact live API
source/image and publishes to the existing Connect CloudFront distribution.
The Sites project for the main website is a separate surface.

Finally record the matching Windows0.7.1 installer source/artifact and installed
100%/125% screenshots, then run the original combined state: retained installation
and queued evidence, no assigned facility, expired saved review. Facility recovery
must lead; saved-file renewal remains an explicit optional route. Verify facility
assignment and configuration approval against the newly deployed backend with
the user's real retained state. CI fixtures and owner probes do not demonstrate
that final user journey.

## Failure and recovery

Failures emit closed diagnostic codes and perform no automatic rollback. Retain
the previous image and all actual receipts. Before130, the original image remains
the predecessor. After130, the raw129 image deliberately rejects the ledger; only
the exact compatibility bridge is an eligible reverse image. The separate
`recovery-runtime-runner.mjs` constructors require fresh actual-role qualification,
zero admitted0.7.1 work/replays/projections, and reverse the API before the worker
with a new review after the API reversal. Do not use the retired77 migration
workflow or bypass the schema/role tests. No permission grants, network changes,
feature activation or broad rollback path is implicit in this coordinator.
