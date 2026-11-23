# Exact guided facility activation

This is a separate configuration operation after the recovery130 candidate has
been verified on both services. It changes one exact facility entry in the API's
`PACKPROOF_GUIDED_FACILITIES` setting. It preserves the actual API image, release
source/version, every other container setting, secret reference, role, service
setting and network, and the entire worker configuration. No database assignment,
source approval, collection activation, assistant activation or IAM edit occurs.

The allowlist controls a **facility**, including its otherwise-authorized
installations. The selected installation proves the intended existing binding;
this operation is not a device-only feature flag.

## Prerequisites and private selection

1. Finish the candidate130 rollout and retain its actual `images.json` build
   receipt. Both live services must still use that exact candidate, and the fixed
   API-role inspector must observe the exact130 ledger.
2. Use the existing authenticated facility connection flow to establish the
   intended nonnull location. Do not invent a facility, use a device name as an
   identity, or select the first item from an inventory. If the user's intended
   facility is unknown, obtain their actual choice from the bounded private list.
3. Run the existing encrypted facility inspector and authenticate/decrypt it
   locally. Keep the X25519 private PKCS8 PEM local with mode0600. Public requests
   carry only its DER SPKI public key in base64. Never publish the plaintext
   inspection, Cognito subject, organization/location/installation IDs or names.
4. From the user-chosen **already-bound** installation row, calculate the public
   pins with the pure exports `guidedSelectionDigest(row,subjectSha256)` and
   `guidedScopeDigest(row)` in `recovery-guided-activation.mjs`. The former binds
   the exact subject digest, installation, organization, environment and location;
   the latter binds the exact organization/environment/location. SHA-256 uses the
   UTF-8 JSON arrays and domain prefixes implemented by those functions. No case
   folding, trimming or inferred scope is permitted.
5. Inspect current runtime metadata and retain its exact `expected` pins. The
   global order workspace flag must already be true. A selected tuple present in
   the assistant allowlist is refused: adding guided eligibility would otherwise
   turn on the assistant indirectly. Opaque or wildcard facility settings are
   refused. Existing exact guided entries are preserved byte for byte.

The new tooling source must be an exact main commit with its own successful main
CI. It may follow the deployed application commit. `verifyRuntimeInputs` verifies
that the original runtime source is its ancestor and that every reviewed Docker
COPY input and immutable recipe is unchanged. The workflow re-reads the original
CodeBuild result, registry digests and source-bound build logs; it does not relabel
the running image or borrow the newer tooling's CI as application evidence.

## Public request schema

Push one reviewed JSON file at `infra/connect-rollout/guided-promotion.json` on
main, or dispatch `Connect exact facility activation` with the same JSON. No
request file is installed by this implementation. Placeholder values below are
not execution evidence:

```json
{
  "schema": "packproof.guided-activation-request/v1",
  "operation": "activate",
  "source": "<successful-main-CI-tooling-commit>",
  "build": {
    "source": "<original-candidate-source>",
    "archiveSha256": "<actual-build-receipt-archive-hash>",
    "sourceVersion": "<actual-versioned-source-object>",
    "buildId": "<actual-CodeBuild-id>",
    "ciRunId": 123,
    "candidate": "<actual-immutable-candidate-image>",
    "fallback": "<actual-immutable-compatible-image>",
    "predecessor": "<actual-original-image>"
  },
  "expected": {
    "api": {"source": "<candidate-source>", "image": "<candidate-image>", "taskDefinition": "<observed-API-task-definition>"},
    "worker": {"source": "<candidate-source>", "image": "<candidate-image>", "taskDefinition": "<observed-worker-task-definition>"},
    "topologySha256": "<fresh-runtime-pin>",
    "preservationSha256": "<fresh-runtime-pin>"
  },
  "facility": {
    "subjectSha256": "<digest-of-exact-verified-subject>",
    "selectionSha256": "<digest-of-user-chosen-bound-installation>",
    "scopeSha256": "<digest-of-exact-facility-tuple>",
    "recipientPublicKeySpki": "<X25519-DER-SPKI-base64>"
  },
  "expiresAt": "<future-UTC-time-within-two-hours>"
}
```

Copy only the eight named build fields from the verified build receipt. GitHub
supplies both actual CI records; they are not accepted from public request JSON.
Do not push another main commit while the intended tooling commit's CI is still
running. A subsequent request-only commit may refer to that completed ancestor.

## Execution and acceptance

The workflow shares the existing release concurrency lock and uses four bounded
sessions: read-only build/runtime verification, a fixed read-only API-role task,
the existing API service update, and a distinct final read-only API-role task.
It uses the existing deploy identity and preserves all passed roles. It neither
adds policy grants nor falls back to broader credentials if a call is denied.

The precheck generates a separate ephemeral X25519 key in runner memory. The
fixed inspector encrypts before stdout/CloudWatch; only the runner can decrypt
that precheck. It checks the current active human, current OWNER/ADMIN role,
enabled organization, already-bound installation, acknowledged enrollment with
no pending renewal, nonpaused/nonrevoked status, and the intersection with the
active enrolled operator's facility grants. Truncated or ambiguous results fail.
The configuration plan expires within five minutes of that actual inspection.
Immediately before the update it rechecks the live configuration pins. Request
hashes cannot choose arbitrary SQL, scripts, environment names, roles or images.

Raw AWS requests, private plans and plaintext observations stay outside the
artifact directory. The ephemeral runner private key is never written or
published. Only whitelisted hashes/statuses and the final encrypted facility
inspection appear in `connect-guided-<operation>-<source>-<run>` artifacts.

Download the artifact, authenticate/decrypt `facility-encrypted.json` locally
with the retained operator key and exact runtime source/image/ledger/task/subject
bindings, and recheck the selected row. For activation it must show the same
location, current eligibility, `guidedSetupAvailable:true`, and
`assistantSetupAvailable:false`. A successful configuration receipt alone does
not authenticate the encrypted final account observation. The result explicitly
marks that local verification as outstanding.

Finally obtain the actual signed-in human's successful workspace-access response
and the installed service's fresh heartbeat capability
`guidedFacilitySetup:true`. The executor does not impersonate the user or emit a
claim that these client checks ran. Existing source and collection approvals stay
in force. Merely adding a tuple is not a receipt of working warehouse ingestion.

## Rollback and interrupted runs

`configuration.json` and `result.json` include bounded rollback pins if this run
actually added a tuple. No rollback material is fabricated for an existing-entry
no-op. Preserve the previous API task definition until this activation is
accepted; its immutable environment supplies the exact previous guided value.

For a scoped rollback, obtain fresh current `expected` pins, use the same exact
selection and original build, set `operation` to `rollback`, and add the exact
`rollback` object from that verified activation result:

```json
{
  "previousApiTaskDefinition": "<retained-previous-API-definition>",
  "previousPrimaryContainerSha256": "<verified-before-container-hash>",
  "activatedPrimaryContainerSha256": "<verified-after-container-hash>"
}
```

Rollback still requires current authorized bound scope. It re-reads the actual
previous task definition, requires every nonguided setting and image to match,
and verifies that the current value is exactly the previous value plus this one
tuple. It restores only that previous guided value on the same candidate. Other
pilot changes, a changed image/configuration, a missing old definition or revoked
authority require a new explicit operational review; they are not overwritten.

No automatic rollback runs on an error. A failure receipt records whether the
update was attempted or acknowledged. Inspect the actual service before retrying
an interrupted run. If the API update completed but final inspection failed,
retain the configuration receipt and run a fresh encrypted inspection. Image
release and rollback gates remain unchanged; if they require absent facility
allowlists, reverse the applicable separately authorized activation first.
