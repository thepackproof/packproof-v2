# Research backend

This branch keeps the ordinary finalized Proof manifest and original export format unchanged. Research writes use migrations 079 onward, private immutable objects, isolated signing keys, and a signed extension chain anchored to the root manifest. Customer display remains blocked for every feature because no physical, hardware, privacy, or model profile has completed qualification.

## Boundaries and execution

`rndConfigFromEnv` defaults every feature operation off and the kill switch on. `assertResearchRuntimeIsolation` runs before database, signing, integration, or object storage initialization; the source marker requires explicit research identity even when analysis flags are disabled. This backend accepts local development identities, local private objects, and local research database names/directories. It binds the research HTTP listener to loopback. Live commerce, billing, cloud signing/storage/recovery credentials are rejected. The ordinary production build must not distribute this branch.

Every request resolves ownership and authorized lifecycle participants from core records. Source IDs resolve only to committed ordinary evidence, committed lifecycle-stage evidence, or signed native frame sidecars of the same Proof. Sources retain their separate leg/package subjects. A cross-leg comparison accepts exactly two sources. Source object version, SHA-256 and length are checked before queueing and again before decoding.

Analysis admission is limited to 32 active jobs per tenant and 20 comparisons per tenant/hour, serialized by an advisory transaction lock. HTTP research surfaces have a distributed 120 requests/minute/actor limit. The public derivative-grant redemption endpoint has a separate 30/minute/IP limit. Original idempotency retries return the recorded result without consuming admission again.

The durable queue leases work with expiry, a token and bounded attempts. Only the current unexpired lease can append a result. Failed operations remain `FAILED`/`NOT_CHECKED`; they never become a difference finding. A completed result and its signed extension are committed together under the same Proof lock. One heavy ZK task can run at a time across queue workers. Admin retry creates a new record and audit event; it does not rewrite a failed result.

Executable inventories freeze backend modules, shared validation, actual Python implementations, ZK circuit/verifier files, configured model bytes/releases and witness trust policy. Changed executable bytes require a new analysis request. Python executes without a shell in a bounded process group, with timeout/output/source/artifact limits, sanitized environment, and full process-group termination. A configured OS sandbox wrapper is supported; a bare subprocess is explicitly reported as lacking network isolation.

## Evidence operations

- F01/F03/F04/F06/F08 use the actual Python vision worker and immutable committed media. F01 freezes enrollment groups and source/frame bindings; no unqualified physical enrollment is promoted. F03 optional numeric model files require server-pinned digest and release identity. Passive F06 observations do not authorize illumination or establish replay resistance.
- F02 records signed capture intents, single-use starts and closed committed file inventories. Native signatures bind the exact canonical final-file payload. Platform-assurance adapters maintain separate validated/unsupported states; no client success claim upgrades assurance. Concurrent sidecar receipt chains preserve acquisition/journal and frame commitments.
- F05 builds a deterministic matrix from frozen supporting analyses, explicitly source-bound immutable shipment observations, client-reported decoded labels and an actual appearance diagnostic. Exact OCR strings and numerical reported weights retain uncertainty and attribution; agreement does not establish physical correspondence. Provider versus participant mass reports remain distinct. No score fusion or responsibility attribution exists.
- F07 creates actual opaque derivatives, records transformation or verified bounded ZK proof lineage, and requires human approval of the exact artifact/recipe before export. Derivative-only exports omit originals and source-dependent findings. Private ZK witness pixels/blinds are never artifacts or export inventory. Optional hosted grants bind approved bytes, bounded expiry, revocation and per-chunk checks; downloaded archives remain irrevocable.
- F09 persists a private blinded commitment in the request before log submission. Repeated delivery deduplicates the same leaf. Optional two controlled local witnesses persist signed checkpoints and verify consistency after restart. Their assurance is `TEST_WITNESSED`, with zero independent operators; without configured operators the result is `LOG_INCLUSION_ONLY`.
- F10 imports pinned, signed research model/report artifacts through a system-admin registry. Ordinary evidence sources provide review context and are not consumed as training data. Learning consent and system-admin status are rechecked.

Reviewer corrections are signed append-only participant statements linked to an existing analysis/source and optional video interval. Supersession retains earlier statements and cannot rewrite machine findings. Queue metrics expose state, age, attempts, latency and error summaries without private media. Witness metrics project at most 100 completed receipts into checkpoint age, policy/log identity, signature count and assurance, without reading openings into the returned result. Attention errors summarize jobs created in the previous 24 hours by safe processing-stage code; operator/consistency-stage failure does not by itself identify an attack. Checkpoint age is a measurement, not a qualified external publication SLO.

## APIs

`GET /rnd/capabilities` reports safe feature flags. Authorized Proof participants use `/proofs/:id/rnd/analyses`, `/comparisons`, `/derivatives`, `/annotations`, capture-intent endpoints, enrollment endpoints, and platform-assurance challenges/results. `GET /rnd/analyses/:analysisId` returns operational/finding state and a typed result. Analysis artifacts are fetched by bounded inventory index under the parent Proof route.

`POST /proofs/:id/rnd/exports` produces the signed metadata snapshot; `GET /proofs/:id/rnd/export.zip` includes authorized originals and public analysis artifacts. The snapshot signs root, ordered extension/intent/receipt digests, exact sources/artifacts, annotations, enrollments, sidecars, audience, omissions and export mode. Source/sidecar bytes are rechecked while streaming. The portable verifier requires trust pins supplied independently of the bundle.

Admin operations are `/admin/rnd/metrics`, `/admin/rnd/analyses/:analysisId/retry`, and learning registry endpoints. Every mutating research route uses explicit actor authorization and idempotency where applicable. No research route re-finalizes the root.

## Witness and worker configuration

In addition to the local runner environment, worker configuration uses `PACKPROOF_RND_PYTHON`, `PACKPROOF_RND_WORKER_SCRIPT`, and optional `PACKPROOF_RND_SANDBOX_EXECUTABLE`/`PACKPROOF_RND_SANDBOX_ARGS` (JSON argument array). ProofSight model pins use `PACKPROOF_RND_PROOFSIGHT_MODEL_PATH`, `_SHA256`, and `_RELEASE_ID`.

The witness adapter uses `PACKPROOF_RND_WITNESS_SCRIPT`, `_PYTHON`, `_DB`, `_KEY`, `_LOG_ID`, `_POLICY`. Optional `PACKPROOF_RND_WITNESS_OPERATORS` is a JSON array of exactly two `{operatorId,keyFile,stateDb}` records. Both names and keys must be pinned in a test-only policy with `independent:false`; no production independence can be claimed by this adapter.

Test interpreters can be selected using `PACKPROOF_RND_TEST_VISION_PYTHON` and `PACKPROOF_RND_TEST_PRIVACY_PYTHON` for the boundary suite. Install the committed pinned research requirements into isolated virtual environments first. Full measured hardware, native toolchain, external independent witnesses, real partner data and scientific qualification remain separate validation gates.
