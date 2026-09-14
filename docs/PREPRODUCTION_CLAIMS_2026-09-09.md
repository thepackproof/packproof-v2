# Preproduction testing and claims integration

This release implements the September 9 development plan over the current capture and color candidate. It preserves one canonical transaction-bound Proof and adds claims access around the existing disclosure and viewer system. Live marketplace credentials, a configured Zendesk workspace, and physical shipments remain external acceptance gates. Configured credentials are never reported as successful live integration tests.

## Implemented behavior

Default registries do not expose demo marketplace, storefront or carrier adapters. Only explicit isolated test harnesses opt into fixtures. Developer integration routes require that test harness flag and cannot mount in staging or production. The unused web demo connection action has been removed. The public marketing example remains explicitly illustrative and has no operational ingestion path.

Staging and production startup reject developer login and an enabled sandbox eBay runtime. Set `PACKPROOF_EBAY_INTEGRATION_ENABLED=false` while production onboarding is incomplete. Existing sandbox credentials can remain stored without importing sandbox orders into the normal staging UI. Tests use their own temporary databases and fixture registries.

`GET /ready/integrations` returns a safe readiness summary. `npm --prefix backend run check:integrations` emits configuration issues without secret values and exits 2 when blocked. This is the extensive-testing gate; `/ready` continues to measure application dependencies so absent optional providers do not take down capture or recovery. A configuration-only result is `CONFIGURED_UNVERIFIED`, never a claimed successful live test.

The API produces one request ID shared by the HTTP response, platform audit and synchronous integration logs. Provider jobs retain their connection and transaction IDs for correlation. Existing transaction provenance, intake observations, capture-label observations and carrier event provenance remain machine-readable. Unsupported sales reuse manual order/context intake and the same capture/finalization commands; no Marketplace or Craigslist scraping or order API is introduced.

## Claims API and authorization

Issue a dedicated tenant key with only `claims:read`. It cannot create or edit Proofs, finalize evidence, mutate tickets, send messages, buy labels or make claim decisions. Tenant identity comes exclusively from the authenticated key. Requester email is intentionally not an unrestricted search key.

Before a Proof is discoverable, its seller must approve sharing through the existing preview-and-consent flow. Then the seller authorizes that existing grant for the intended tenant using their normal authenticated session:

```http
POST /me/tenants/:tenantId/claims-proofs/:proofId
Content-Type: application/json

{"accessLinkId":"<reviewed grant ID>","externalId":"<order reference>"}
```

The seller must own the tenant and be the Proof's seller. A reviewed `SHARED_PROOF` or `CLAIMS_REVIEW` disclosure is required. The API does not infer media consent. Repeated identical authorizations return the same authorization; replacing the reference or grant requires revocation first. Revocation uses `DELETE /me/tenants/:tenantId/claims-authorizations/:authorizationId`.

```http
POST /v1/claims/lookup
Authorization: Bearer <claims-only key>
Content-Type: application/json

{"ticketId":"1001","workerId":"2002","orderId":"<reference>"}
```

Supported identifiers are `proofId`, `externalTransactionId`, `orderId`, `trackingNumber`, and `ticketReference`. Tracking removes spaces/hyphens and normalizes case. Order identifiers preserve case. All supplied identifiers must agree. No fuzzy selection or email search occurs. More than one authorized match returns `MULTIPLE_MATCHES`; none returns `NOT_FOUND`. Results are limited to 20, with `hasMore` signaling the need for a narrower reference. `EXACT_IDENTIFIERS` describes the matching method, not the truth of a claim.

The response contains Proof identity and state, disclosed order/shipment context, recording count, a compact chronology and carrier summary. Integrity recomputes the stored canonical manifest hash. This is explicitly narrower than rechecking all media bytes or establishing physical package contents. Media playback continues through the existing integrity-checked, authorized streaming path.

```http
POST /v1/claims/proofs/:proofId/open
Authorization: Bearer <claims-only key>
Content-Type: application/json

{"ticketId":"1001","workerId":"2002"}
```

Opening returns the canonical `/p/:token` viewer URL, expiring after at most 15 minutes or the parent grant's earlier expiry. Only token hashes are persisted. Raw S3 URLs are never returned. Every read rechecks the claims authorization, API key revocation, parent grant and expiry. Parent disclosure changes govern later reads. The original reviewed scope is reused; no second evidence packet is created.

Lookups, including no-match lookups, are recorded in `claims_access_events`. Matched Proofs receive `CLAIMS_LOOKUP_MATCHED`; issued links receive `CLAIMS_VIEWER_ISSUED`; every successful viewer-document open receives `CLAIMS_PROOF_OPENED`. Ticket ID is retained, worker ID is hashed, and raw search values are excluded from access logs. Worker and ticket IDs supplied by the sidebar are caller-reported context, not independent proof of a Zendesk agent's identity. The authenticated principal remains the tenant API key. This MVP cannot cryptographically attest to a Zendesk ticket; the live workspace acceptance test is still required.

Migration 059 adds append-only claims access/session records and revocable authorization records. Authorization/session policy changes use the existing policy recovery journal. Core manifests, evidence and Android biometric behavior are unchanged.

## Zendesk installation

The private sidebar app source is `integrations/zendesk`. Package the manifest, translations and assets at ZIP root. Install in a dedicated Zendesk test workspace through Admin Center's private app installation flow. The package targets the existing staging API and opens the canonical viewer on `thepackproof.com`.

Set `claims_token` to a dedicated `claims:read` key using Zendesk's secure installation setting. Never paste it into client JavaScript. Optional `proof_id_field`, `order_id_field`, `tracking_field`, and `reference_field` settings accept numeric Zendesk custom-field IDs. Without mapped fields the worker enters one identifier. Ticket ID and current agent ID are read from ZAF. The app never reads ticket comments/requester email, writes a ticket, or sends a message.

The sidebar uses ZAF `client.request` through the Zendesk proxy with `cors:false`, `secure:true`, a secure-setting placeholder and an exact API domain whitelist. Its single Open Proof action requests a fresh viewer grant. Popup blocking, missing setup, no match, multiple matches and provider failure produce plain-language recovery. A server-only credential is never materialized in the iframe.

Implementation references: [Zendesk request and secure-setting guide](https://developer.zendesk.com/documentation/apps/app-developer-guide/making-api-requests-from-a-zendesk-app/) and [ZAF Client API](https://developer.zendesk.com/api-reference/apps/apps-core-api/client_api/).

## Credential ownership and rotation

Collin is the current account owner; these are operator responsibilities, not claims that credentials have been provisioned.

| Provider | Managed location and intended scope | Rotation and revocation |
| --- | --- | --- |
| eBay | Separate `packproof/staging/integrations/ebay/production/app` and account credentials; seller order reads | Rotate application secret, update managed version, reconnect authorized seller; revoke old app/account grants in eBay |
| Etsy | `packproof/staging/integrations/etsy/live/app`; production receipt/order read permissions | Rotate app secret, update reference, reauthorize seller; revoke old Etsy grant |
| Shopify | `packproof/staging/integrations/shopify/live/app`; existing read-order/fulfillment scopes | Rotate app secret through Shopify, update managed reference, reauthorize store if required; revoke old app grant |
| Shippo | `packproof/staging/integrations/shippo/live/tracking`; tracking only | Rotate token in Shippo, write new managed version, retry a known real tracking number; revoke old token |
| AWS and Cognito | Existing task/execution roles and managed database references; no client secrets in bundles | Use role/policy changes and managed rotation; roll tasks for injected credential changes, verify callback and storage access |
| Zendesk | Dedicated PackProof tenant key in Zendesk secure setting; `claims:read` only | Issue replacement key, update secure setting, verify lookup, revoke old key; outstanding links tied to the old key then stop working |

Use separate namespaces for production deployment credentials as well; staging live-provider credentials do not imply a production PackProof rollout. Label purchase, refund and message/ticket mutation are outside this MVP. A Shippo live token's permission breadth is a provider property; PackProof exposes no label-purchase operation here.

## Staging reset procedure and rollback

`backend/scripts/staging-cleanup.mjs` is an offline operator command. It accepts only the configured staging PostgreSQL database named `packproof_v2`. First run inventory, then verify the RDS snapshot and object backup, then apply the exact inventory fingerprint. It locks the enumerated dependency graph and aborts if the fingerprint changes. It uses explicit `TRUNCATE ... RESTRICT` only for transaction-dependent operational tables; runtime mutation guards remain installed. Accounts, API tenants/keys, provider connections, secret references, schema, and independent policy history remain intact. Automatic order sync is paused.

The September 9 reset used snapshot `packproof-preclaims-20260909-1620`, verified available before deletion. Pre-reset API SHA was `cc8209d50774d124646fa9c373eac537bc168e9b` on ECS task revision 19. Nineteen Proofs, 22 transactions, five evidence rows and their enumerated dependents were removed. Evidence backup inventory is in `s3://packproof-v2-staging-build-784514617543/backups/preclaims-20260909/objects.json`; it records every original key/version and backup copy. Nineteen evidence object versions totaling 988,000,962 bytes and one old delete marker were removed from the evidence namespace, including legacy orphan files. The readiness sentinel was retained.

Rollback requires restoring the snapshot to an isolated RDS instance, restoring backed-up objects to their original keys, verifying manifest/object references, then switching the staging database endpoint under a maintenance window. Restored version IDs differ: reconcile pinned storage identities before claiming old evidence is usable. Do not point live writers at both databases. Backups remain private operator data and must not be wired into product fallback paths. Snapshot availability and successful object copies were verified; an actual restore drill was not performed in this session.

## Acceptance evidence and remaining gates

Focused local checks cover claims lookup/open/playback/audit, tenant isolation, conflicting identifiers, multiple matches, expiry/revocation, immutable finalization, shared disclosure behavior, carrier normalization/retry, empty accounts, web navigation/rendering, mobile API contracts and recovery. The live Shippo smoke test remains skipped until a real token/tracking pair is available. Automated evidence is not a real shipment or an installed Zendesk workspace test.

The remaining real-world matrix is deliberately small: one authorized connected order; one physical label/carrier lifecycle; one Zendesk ticket locating and opening that same Proof; one manually entered unsupported-marketplace transaction; and one offline/provider-delay recovery. These can reuse three to five physical shipments. Record Proof ID, ticket ID, carrier, observed timestamps, request IDs and the exact release for each case. Do not buy labels until the live credential and Zendesk installation gates pass.

Extensive testing is **not yet approved** solely by deploying this candidate. Required completion evidence is a real connected order, live carrier events, an installed Zendesk sidebar used by a claims worker, and the physical device/shipment checks. Browser-extension and Salesforce work remain deferred as directed by the plan.

## Release state at handoff

The source changes are committed locally on `codex/preproduction-claims-2026-09-09`, based on the approved September 9 capture/color release `a783a55`. Backend typecheck/build, the web production and Sites builds, and the focused backend/web/mobile checks passed. The targeted suite covered 63 passing tests; one live Shippo test was skipped for missing live credentials. Migration 059 was exercised in the isolated database harness; it has not been applied to staging.

Staging cleanup is complete. A later AWS check confirmed the RDS snapshot remained available, there were zero remaining evidence object versions or delete markers under `evidence/`, and the existing API service had one healthy running task. The existing deployed API release remains `cc8209d50774d124646fa9c373eac537bc168e9b` (task revision 19); the new claims endpoints and fixture safeguards are not live.

Automatic approval review rejected source publication to the public `thepackproof/packproof-v2` GitHub repository. Account ownership and push permission were verified, but review still required explicit authorization to publish the potentially nonpublic changes. No source push, new CodeBuild build, deployment, database migration, Zendesk installation, or label purchase occurred after that rejection. The release archive contains the source patch and incremental Git bundle so the implementation can resume without redoing the work.

After explicit source-publication and deployment approval, publish this branch, build the backend from this exact source, apply migration 059 once, and deploy with `PACKPROOF_EBAY_INTEGRATION_ENABLED=false` until real eBay onboarding is complete. Then verify `/health`, `/ready`, `/ready/integrations`, tenant-isolated claims behavior, and the canonical web viewer before installing the private Zendesk app. A 503 from `/ready/integrations` remains expected while required live-provider configuration is absent; it must not be represented as integration acceptance.
