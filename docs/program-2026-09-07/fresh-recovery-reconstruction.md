# Fresh accepted-record reconstruction

`backend/src/domain/recovery-restore.ts` and `backend/src/db/restore-cli.ts` implement an offline restore into a **new, fully migrated, empty database**. An older disk backup remains a separate comparison source. The importer refuses in-place mutation of a backup and never disables a trigger, changes the replication role, blindly upserts accepted records, opens traffic, or enables a writer.

The operator provides complete core and policy journals from genesis, independent signed latest watermarks, separately provisioned trusted public keys, exact retained source object access, a new writer generation, and references documenting target isolation and external old-writer fencing. References are recorded as operator evidence; their presence does not independently prove infrastructure isolation.

The target login must be a dedicated `packproof_restore` role (or `packproof_restore_<suffix>`), without superuser or bypass-RLS authority. Its actual database name must match the spec. Provision only the necessary table read/insert/update, schema usage and sequence privileges on the isolated target. Run migrations separately through the migration role. The importer locks the target, checks that domain tables are empty, then durably disables writers and closes policy access before validating the remaining inputs.

Restore verification checks signed canonical envelopes, genesis-to-head chain continuity, the independent expected core and policy heads, policy references from every accepted core receipt, protected source journal bytes and versions, frozen manifest signatures/digests, supplement ancestry/signatures, finalized stage digests, and the full digest and byte size of every exact preserved media version. Recording verification streams with the same 250,000,000-byte maximum used by media admission. An absent source version, missing dependency or mismatched field closes the restore.

The importer installs authenticated policy history before domain inserts to preserve the source sequence range. It inserts the latest complete Proof snapshots in dependency order, applies the latest signed permission state, and uses ordinary permitted lifecycle transitions to set final statuses only after the dependent rows exist. All of this domain application happens in one database transaction. Immutable core events, exact durable receipt identities, supplement heads, and the deterministic finalization audit event are restored. Source revocations remain revoked. Normal policy triggers append separate local reconstruction events after the authenticated source policy head.

The returned report always has `trafficMayOpen: false` and `writersEnabled: false`. The policy fence remains `RECONCILING`; a successful import does not clear it. A verified, independently authorized cutover must cover the old deployment's writer/IAM fence, local reconstruction policy publication/reconciliation, other product metadata, and the measured deployment restore drill. Merely calling the policy completion helper does not enable the recovery writer.

## Offline CLI

Compile the backend, or invoke the TypeScript entrypoint through the repository's installed `tsx`:

```bash
tsx backend/src/db/restore-cli.ts restore-spec.json restore-report.json
```

The CLI requires `PACKPROOF_RESTORE_DATABASE_URL`; it deliberately does not use the runtime `DATABASE_URL`. `PACKPROOF_RESTORE_TRUST_FILE` points to an independently provisioned JSON object containing `publicKeys: { keyId: publicPem }`. The standard object-store configuration must address the retained source store and explicitly have verified immutable recovery storage enabled. Do not derive trust keys from the bundle being restored.

Example spec, with envelope paths relative to its directory:

```json
{
  "version": 1,
  "expectedDatabase": "packproof_isolated_restore_20260907",
  "restoreRole": "packproof_restore",
  "isolatedTargetReference": "approved-drill/target-isolation-evidence",
  "oldWriterFenceReference": "approved-drill/external-writer-fence-evidence",
  "targetWriterGeneration": "restore-20260907-unique-generation",
  "core": {
    "envelopes": ["core/evidence.json", "core/declaration.json", "core/finalization.json"],
    "expectedWatermark": "independent-heads/core-finalization.json"
  },
  "policy": {
    "envelopes": ["policy/0001.json", "policy/0002.json"],
    "expectedWatermark": "independent-heads/policy-0002.json"
  }
}
```

The report path must be new and is written with owner-only permissions. The CLI does not log source snapshots, credentials, connection strings, or provider errors. Admission limits are 10,000 envelopes per journal, 16 MiB per envelope, and 256 MiB total input. Larger deployments need a separately reviewed streamed journal inventory strategy.

## Tested boundary and remaining coverage

Migration 047 transactionally freezes Proof and transaction parent context with policy changes and adds a newly dated baseline for existing participants without rewriting old events. The signed `PACKPROOF_POLICY_PARENT_CONTEXT` explicitly states `coreAcceptance: false`. Fresh reconstruction can restore unrelated unfinished Proofs from that context while the same corpus restores durably accepted final records. The report lists `contextOnlyProofIds`; these receive no invented evidence, final manifest, core accepted event or durable finalization receipt. Their fields are the preserved context at the policy event time, not an assertion that every later unfinished edit was acknowledged durably.

Historical journals lacking the required context stop with `RECOVERY_RESTORE_DEPENDENCY_GAP`. A committed/finalized parent context without its accepted core journal also stops rather than manufacturing missing originals or downgrading an accepted final record. All restored drafts and final records stay behind the same closed policy and writer fences.

The regression fixture creates a disk backup before recording, commits and acknowledges strict finalization afterward, then revokes an access link. It rejects the stale backup as a mutation target and reconstructs into a new database. It compares the original canonical manifest and digest, exact evidence rows, accepted core events, audit set at acknowledged finalization, and final preservation receipt. It restores the consumed native declaration challenge and verifies that its accepted signature can recover the same declaration after expiry. The post-backup revocation is retained, while participant/guest access and writer publication remain closed. Another case restores finalized recipient-stage recordings and signed supplement ancestry without changing the seller manifest. Separate failures exercise wrong authority, stale expected heads, unavailable exact media, and database immutability after restoration.

This reconstructs records represented by the accepted core and policy journals. Unfinished parent contexts are reconstructed only when explicitly present in the signed policy journal; older missing parents fail dependency validation. It does not restore billing, connections/refresh credentials, signature-product caches, relay sessions, external integration jobs, or domain audit rows created after the latest core snapshot. Those require their own authenticated backup/recovery boundary before cutover. Policy journal facts retain database attribution; they do not reconstruct a missing later domain audit event.

Invitation bearer tokens were intentionally excluded from the policy journal. Restored invitations receive fresh, unexposed random nonces, so old invitation URLs do not gain access. The report lists invitations requiring deliberate reissue after reconciliation. Existing hashed access-link and API-key identities are restored from their exact signed policies, including revocation state.

Legacy committed media or reviewed derivatives without an exact preserved version cannot pass this importer. Derivatives require a separately verified regeneration/review path with disclosure closed. Missing objects, inconsistent supplement ancestry, unknown schema fields, unavailable key authority, or unsupported dependency coverage stop restoration safely. Successful local tests do not substitute for the actual PostgreSQL/S3 deployment restore drill, measured recovery time, decryptability and role-isolation evidence.
