# Future platform — frozen baseline and reuse inventory

Audit date: September 10, 2026. Scope: source inspection and previously saved release receipts. No cloud changes, account connections, production data reads, migrations, resets or device tests were performed for this inventory. Release receipts describe the time they were recorded; they are not a fresh live-environment certification.

## Frozen release reference

| Component | Verified reference | Evidence and limits |
|---|---|---|
| Source | `a5041731af99c09f9031c4e512b5742e78c8388e` | Local source and recorded build/deployment metadata agree. Message: queue seller uploads, restore barcode feedback, streamline video transfer. GitHub main at discovery was older `d8dfe24` / build 39; it is not this freeze baseline. |
| Future branch | `future/platform-foundation-2026-09-10` | Isolated from the frozen release. No future feature activation implied. |
| Android | `0.3.15`, version code `44`, `com.packproof.mobile` | `mobile/app.config.js`; recorded signed AAB verification. Package.json's `0.1.0` is not the app release version. |
| Android bundle | `packproof-0.3.15-44.aab`, 46,554,744 bytes | SHA-256 `60ee92055be0fc9133135f53bfa99bed36fea6e9a3a4d1dd033628ddae37a24e`. Saved verification reports JAR signature, bundletool, API URL, packaged source SHA and upload-service checks passed; no credentials packaged. Play submission recorded false. This is not physical-device validation. |
| Backend | Release `2026-09-10-usps-upload`, source `a504173` | Saved health/readiness HTTP 200 and capabilities source at `2026-09-10T19:04:36.931Z`; ECS deployment subsequently `SUCCESSFUL` at `2026-09-10T19:07:38.351Z`, one requested/running task, zero failed circuit-breaker attempts. |
| Backend image | `sha256:7499d295bd3166088a7a13afdf3582b6ad42c69b4d763b40686bf6af2a2be124` | Saved Android release metadata links this image to the backend deployment. |
| Web | Source present at frozen commit; package version `0.1.0` | No web deployment receipt was inspected here; do not substitute the backend commit for a verified deployed web version. |
| Database | Frozen source inventory `001`–`060`: 61 SQL files | Both `027_automatic_commerce_intake` and `027_notification_delivery_leases` exist. Full migration IDs, not numeric prefixes, are authoritative. Checksums below are source bytes, not proof every migration ran live. |

Receipt sources in the prior workspace: `backend-deploy/completed.json`, `backend-deploy/live-verified.json`, `android-build/build-state.json`, and `android-build/verification.json` under `/workspace/scratch/0516212f217c/`. Only non-secret release metadata is recorded here.

Architecture: Node/Express modular backend, PostgreSQL authoritative relationships, original-preserving object-store adapters, Cognito authentication, Vite/React web and Expo/React Native Android. Package manifests specify Express `^4.21.2`, pg `^8.16.3`, TypeScript `^5.9.2`; exact runtime/deployed versions require their own receipt. No backend rewrite or new service is needed for this slice.

## Work-packet reuse map at the frozen commit

| Packet | Existing implementation | Remaining gap / classification |
|---|---|---|
| WP-01 Inventory | This source/build/schema inventory; existing release checks and `/meta`/`/capabilities`. | Complete as a source/receipt inventory. Fresh web identity, database-applied checksums and provider permission/capability audit remain environment gates. |
| WP-02 Contracts/decisions | `backend/openapi.json`; platform contracts; capture core/protocol; source provenance; intake snapshots; parcel scope. | Reconcile public future schema and error/version details, document compatible lifecycle/index signing. General multi-package/multi-return ontology is not proven. |
| WP-03 Trust/access | Tenant scoped keys, immutable tenant-Proof binding, disclosure grants, claims authorization, Android challenge/action signatures, KMS signing runtime, signed trust registries and Python offline trust checks. | No web WebAuthn attestation implementation identified. Device hardware trust and browser parity remain separate gates. New receipt/index context must be signed, not inferred from a signed root alone. |
| WP-04 Durable delivery | Transactional audit→`proof_outbox` trigger, unique webhook/event delivery, database leases, retries/dead-letter/replay, encrypted HMAC secrets, timestamp replay checks, approved HTTPS host/DNS pinning/no redirects. Shippo durable notification inbox triggers authenticated refetch. | Public `listEvents` sequence cursor may miss late-committing lower sequences; outbound dispatcher backfills missing deliveries and does not share that cursor flaw. Legacy webhook receipt identity omits account and is inserted after import; do not claim a universal account-scoped atomic inbox. |
| WP-05 Lifecycle | `commerce_stages` freeze receipt/return manifests without reopening root. `proof_supplements` already stores signed append-only `CORRECTION`, `RECIPIENT_RESPONSE`, `PARCEL`, `CARRIER_UPDATE`, `RETURN` records linked to core and previous hash. | Existing supplement read returns a mutable latest view and a dated-snapshot limitation, not a persisted signed index/head. Extend these stores; do not duplicate the lifecycle evidence core. `UNIQUE(proof_id,stage_type)` limits repeated return workflow scope. |
| WP-06 Capture launch | Migration 058, `backend/src/capture/`, private server SDK `packages/capture-sdk/`, one-time authenticated intents, immutable order/context binding, opaque fragment launch, Android/web adapters, root-backed receipt verification. | Signed completion envelope must bind intent/session/actor and exact receipt context; existing root signature alone does not authenticate every receipt field. Exact host-order return and real external host loop need validation. |
| WP-07 Recovery | Build 44 seller queue; app-owned video retention; same evidence resume/expired-URL refresh; explicit unavailable media/discard; Android native journal; IndexedDB browser chunks; focused recovery tests. | Android capture candidate declares `incrementalMedia:false`; active encoder force-stop can lose an unplayable tail. New fragment writer and real S24 Ultra/A16 storage/reboot/process-death qualification are not done by this slice. Preserve honest terminal/recovery states. |
| WP-08 Portability | Existing `.pkpr` export, exact root and originals, signed supplement entries, original derivation/source references, independent `verifier/verify.py`, trust registry key rotation/status controls and tamper tests. | Authenticate the exported lifecycle index/head and exact disclosed scope; a rewritten unsigned head may hide later entries. A valid historical package cannot prove that no later corrections/revocations exist. |
| WP-09 Context adapters | Existing eBay/Shopify/Etsy commerce adapters; Shippo order and trusted tracking paths; immutable intake snapshots, capture-label jobs, bounded reconciliation and carrier ambiguity checks. | Do not add another connector. Account access, current entity/scopes and real order/tracking behavior are not verified in this source audit. |
| WP-10 Claims compiler | Versioned eBay/Stripe profiles, immutable scoped case, selected source-video stills, original hash/time/tool provenance, renderer workers, size/page/type preflight, exact-digest approval and legibility confirmation. Claims access API uses reviewed grants and exact identifiers. | No provider dispute ID or actual reason-code-specific applicability contract in export request; `requiredFacts` is descriptive. Rendering/approval require temporal revalidation and independent recipient review. No live submission adapter/acknowledgment lifecycle identified. |

Older architecture/execution prose saying Shippo or signing is absent is superseded by the inspected source; it is not evidence of current runtime configuration. Existing test files establish coverage intent, not a fresh passing result.

## Integration capability register

| Source/destination | Source-supported capability | Activation status established by this audit |
|---|---|---|
| eBay / Shopify / Etsy | Server-authorized order import adapters, existing order/fulfillment source records. | Implemented; sandbox/live authorization and production behavior not rechecked. No account settings changed. |
| Shippo | Tracking GET; optional register-then-reconcile; explicit test/live mode and carrier/tracking checks; content-idempotent observations; notification inbox; optional order ingestion. | Implemented in deployed source identified by receipt; account-specific webhook registration, real shipment results and permission scope not independently verified here. |
| EasyPost | Existing trusted tracking adapter and binding retained. | Test/staging capability documented; production capability not established. |
| Claims recipients | US eBay payment-dispute and Stripe export profiles, repository checked date 2026-09-07 / review-after 2026-10-07; local packet preparation. | No portal acceptance, provider approval, recipient comprehension or claim-outcome result established. |
| Capture host | Private server launch SDK, Android/web intent routing and receipt checks. | Reference implementation; no named external host/pilot confirmed. |
| iOS / 3PL / sensors / insurer | Architectural seams and some existing custody/station domain code. | Required devices, organizations, hardware, agreements and operational validation remain unconfirmed. |

## Source migration checksums

Hash method: SHA-256 over exact bytes from frozen commit, ordered by full filename. Preserve both 027 files. This table must not be used to silently adopt unknown live migration checksums.

| Migration file | SHA-256 |
|---|---|
| `001_init.sql` | `3fcf08779f9ae67305fc6a16e700ae3de13a8e73031fc889e0a0f38334bac80d` |
| `002_transaction_shipping_context.sql` | `56c921f1c3258d19691e552c3ec0e6c82dae689dc3f92676e3fe4c2bb12a74b9` |
| `003_profiles.sql` | `6c596c4d944609b5c1a88f1e1dfa061101567225cb5d7bbc5575d14aa7513c62` |
| `004_invitation_invitee_user.sql` | `74b1fd9f43e53130c623b969c0db3eeba4ff0b24c428ecc20fbc788176bff0a7` |
| `005_proof_participants_user_idx.sql` | `a2729b73eaf22b63b3ea8ef51f84977d79b43f8bdf70bc39ec87ba067e883733` |
| `006_canonical_proof_contract.sql` | `7fc23bb83af2eaa3872e84db109fe813b1af938dcde81b2f61e4805c08ce3941` |
| `007_external_reference_identity.sql` | `d85e2af2e4df501d70bf926dbe2dcf087261477c6f51a9d6db9f5e951b236a53` |
| `008_transaction_integration_identities.sql` | `558a4cca0c8293ea204a75e66c6ad33e424be73983393292113a89859acc9c1c` |
| `009_shipment_events.sql` | `3d3bd4dcc25bf62a6c4afa3b120983affd41358d0a288f7d4a2e55bcacc8fad7` |
| `010_trusted_shipment_integrations.sql` | `d536640c2ce15954c637779c4f0693159353a92e1fa054e23d41a4fe547ae1d5` |
| `011_users_search_indexes.sql` | `1519e0d8f8aaaec5fc070a90f18464629395f49627bc3d6bac2eadc950ab5030` |
| `012_automatic_fulfillment.sql` | `7b16a638f275dda98c59a8d5cea2ea26a3550b7a7558d472f8d847e54d4ea157` |
| `013_fulfillment_capture.sql` | `99a0f4bcb7c22d8914d5fde5fb55496689775a7418c25b2af6e29dfe78ad8023` |
| `014_external_identities.sql` | `04e3a82f15cd670a95555bda6f03f0e6aeb2ac7a380dd4696cc07b74b290e454` |
| `015_optional_counterparty_default.sql` | `097eba9c5852fc3666da0c7722fc25fbb362993fffaf43223f58aac057ecb4b9` |
| `016_custody_workflow.sql` | `6532ea8e782fc7e8870ad039a9fb8e0334e94d9612930bc32506b8ce28475f59` |
| `017_connected_accounts.sql` | `1a82703bb2f42545a34b749023c50912a51a245f78234cf80a2399bbd048034c` |
| `018_committed_evidence_immutability.sql` | `ba4db4cda653f9347fb9697eb132168b2ed3de390168b37780df0c78578fbdcb` |
| `019_finalized_custody_guards.sql` | `90b060a7269511bcbd0ead09e645f99ef481c53701d36ce73adc72028a96986f` |
| `020_workflow_protocol_version.sql` | `6515200251a7ec9a41f90a18e62bd7c07c3e6e366352736e9bc6c543a4f030e7` |
| `021_manifest_signature_metadata.sql` | `c1aa21d0e16b60445e4716d720c0f7dd1cf6913e94a88fa6a2f507a671e5878e` |
| `022_proof_email_notifications.sql` | `90af0fa729224c8580839b0877742c1d22bceee459a48b96bf575d0074d7fc61` |
| `023_public_platform.sql` | `646f266b64f71245ce354f8af7fb1b01c80b918bf4002ada8a89f4418b566ce3` |
| `024_resumable_uploads.sql` | `e6f6cc06375daddbb82dd74ce2b6295be0fb19a79da19dba1929272b1c6d8861` |
| `025_commerce_lifecycle.sql` | `7530ebec1e3e0ebda7555a5630ae69f3301e9e43e80d1bc7e8254923af06c138` |
| `026_retention_controls.sql` | `6bd98ba90f3594fa49885d3017cb1808a2bc3b78e40c4384818b914783b8564e` |
| `027_automatic_commerce_intake.sql` | `f72e8a019fc4ebd57280d56e4471328bafeebac5ee468e057216aa10b5484273` |
| `027_notification_delivery_leases.sql` | `cf3ee6fcdd0b238038749f7f95b65601354f1c7347c5cfa878cacaeb70335576` |
| `028_capture_sessions_relay.sql` | `1ca8d283457a8b2a677dac2eed256c799eb77e41369ea6aa49183a8fe5bf5b54` |
| `029_signature_experiences.sql` | `dda0b548437aca2bba4dba972feb15d657dae44fb79563934800ced736f8c691` |
| `030_disclosure_receipts.sql` | `951ca785e6294f0762024eaf582a71957b81786a6b744bef6a683aefb5e53e5b` |
| `031_capture_client_context.sql` | `ea65034f4e1858ba38817ea684bf49996ec6c3677be6e0f8d914a85c5db21bda` |
| `032_capture_shipping.sql` | `835dbdeaaeffd41d3fc1f600a3ce9dc7e53a99052a51959356173dd0e1c9f12e` |
| `033_shared_proof.sql` | `aa23dca9c0fba0213c3e5e255acff496d53e0cfa23d354a22ed500fbca57497d` |
| `034_seller_attestation_authorization.sql` | `8cb160767a8556f544591366ed08e94adb968279cd9908537f0c3fb6ecfa4b45` |
| `035_media_admission.sql` | `f2104bfc14ff1a8fab97a6503c3fcea864341321d927a4947fe8891e529dda43` |
| `036_durable_recovery.sql` | `f35e12d91f2852c986bbe57806fdaa825fd2cdfd56e0a022b533b0f88d294ba4` |
| `037_retention_policy.sql` | `e93e2ac2bfd9a757a1aab4acd6a07dfabac0737add42c96176dec82e9f688088` |
| `038_parcel_tracking.sql` | `0e7e0af54b27d4567fc261e5a033d35a7d0d402b77a0f4043cd2234447550b60` |
| `039_recipient_exports.sql` | `5534d1fdcf598c9622c3d5c77aefbc5cdc643ace361cfb9ef6ff291f1359d1c9` |
| `040_packing_requests.sql` | `9e6366a6048ceb325938f1ce82394937d77c70887a61a927d892ebd9610ed4d2` |
| `041_operations.sql` | `f0d79455388c0397c7d691b2a6d019ec4a77b4f9b70f18a2abecab1ead5e8f02` |
| `042_billing_usage.sql` | `2ba0e5a7c6bd3f31bbd52c8ea59a5c63912e4343e442e7b8b94850c0877876a0` |
| `043_policy_recovery.sql` | `4b6d5e67be77b36e41520a9daf0e3d946fc060d13b2640143af16253d516d910` |
| `044_support_access.sql` | `0877a7bafb8d37146dd4165804a4daf4d2f9f20e855c719021263bdaba5f465a` |
| `045_program_observations.sql` | `1c60b5f9201317a7f9f497f8319661a6c34e86f6b35a14f0197b3f3fdb01cd9f` |
| `046_billing_refund_reversals.sql` | `f325df3e4d6b7f9646f86b800b020f50a792c1217ab0d6caa9f3bd47f9f09eb9` |
| `047_policy_recovery_context.sql` | `23d4e1d54bcabe8881209093bb120f3f0aa86fd0162e441e554cd219e3bba5c0` |
| `048_billing_reconciliation.sql` | `be77bd44622a9aea2dc99838ce0351300dde070a404bd068231f58c613b80947` |
| `049_billing_enrollment.sql` | `2fcaf549ed3541f04887ae8d2391eb24e7689a3a55de13ad23c7c2391a0ee2b6` |
| `050_etsy_connected_accounts.sql` | `57cc78ad72d5ec6763691397255d33d1a823a89924b946e5ee8264aba2cd6b9f` |
| `051_etsy_request_budget.sql` | `53dbb16923efa6a84920fc9f5493247153d9813a2d4728157bb54fd04cd004f7` |
| `052_redesign_integrity.sql` | `2ebb5bb0c5769a878733d42c06c8eb5df4306184a17f0750dad4791b8a10b27e` |
| `053_study_ui_instrumentation.sql` | `deaae42b7bec506b9c196235924df0b9fbfdb33f43b461df2ba7d2cb7d107b30` |
| `054_intake_context.sql` | `96eb983a869c56cd312c6e89387e759fa7dd2fb8fc34e0f0d0674fd6a9b95c39` |
| `055_intake_handoffs.sql` | `614d83fa3fb9029fb1ff7f66d69c76232974e6cfd189d7ba3dc9fe51bd3ee8ce` |
| `056_intake_mail.sql` | `91a3a3c9747cee00878866c770ecc1ecb124061c68bf7bceffe614ce8dcc76c9` |
| `057_intake_shippo_sync.sql` | `2e6e3f95471f8dbfd4a7940741d6bc3f411409657d696f897cf1d67d4e7a62c7` |
| `058_capture_engine.sql` | `097f0e7e79b34d062078d0ccffc177940c5aabca9867fcee219c7806b2374da6` |
| `059_claims_access.sql` | `d4ffbcfc3935f7eafedee047be512573b6145b912cff6f0145ac41fdeb8865a1` |
| `060_identifier_enrichment.sql` | `cae7c9a02b56ce4c622026d3f21971a6236bd6b2291cda944b183e04d71806f4` |
