# eBay production connectivity — 2026-09-13

## Implemented

Web and Android share authenticated server-side OAuth and seller order intake. Android attempts now bind a fixed `packproof-v2://connections/ebay` destination in one-time OAuth state. Success and denied-consent callbacks consume state, return to the original surface, and refresh authoritative connection state. No OAuth tokens or application credentials enter client bundles or callback URLs.

Reconnect checks the original seller's immutable eBay user ID and environment before writing credentials. Renamed sellers reuse the verified connection. Expired/missing authorization marks both account and commerce connection as needing reauthorization. Sandbox tokens cannot be refreshed against production. Web disconnect refreshes all connection projections.

Account-deletion notifications verify eBay signatures independently of whether seller OAuth is enabled. GET challenge verification uses SHA-256(challenge + verification token + exact endpoint). Credential/public-key HTTP requests time out. Notifications are recorded transactionally in `ebay_deletion_cases`; matching seller connections and automation are disabled, credential removal retries in the `ebay-deletion` worker, and matching Proofs from manual imports, current orders, and historical source observations are inventoried for review. Unknown historical identities/environments remain unresolved. Known deleted seller/buyer subjects are suppressed from reconnection/import. Immutable buyer user IDs are retained when supplied by eBay. Operational status reports unresolved case counts.

## Production remains blocked

The user supplied a production keyset whose portal screenshot says it is disabled. Production credentials are stored in a separate managed secret. A server-side production token check returned HTTP 401 `invalid_client`. Only the previous sandbox RuName is known; it must not be represented as a validated production redirect.

**Deletion containment is not complete erasure.** Cases remain `REVIEW_REQUIRED`, and responses explicitly report `recordsErased:false`. Existing signed manifests, append-only source revisions, audit history and recovery copies can contain eBay data. The current repository has retention assessment/locking but no complete disposal executor. This release does not disable immutable guards, claim a no-data exemption, or claim deletion compliance. Historical orders only retained buyer usernames, so changed or masked identities may need additional matching. The production integration must remain disabled until this is resolved and demonstrated with a complete deletion exercise.

## Required activation work

1. Implement and validate provider data erasure across operational, evidence, recovery, export and backup copies; establish explicit handling of demonstrable retention exceptions. Resolve historical identity matching. `REVIEW_REQUIRED` is never completion.
2. In the production eBay keyset, register the HTTPS account-deletion endpoint and the managed verification token; test challenge and signed notification delivery. No-data exemption is not appropriate for PackProof.
3. Obtain the production RuName; set its accepted and declined URLs to the API callback below and the privacy URL to PackProof's published privacy page. Configure `PACKPROOF_EBAY_RUNAME` with the eBay-issued value.
4. Once the keyset is enabled and erasure is validated, enable production OAuth, authorize a real seller, enable automatic orders explicitly, and validate one real order with its resulting canonical Proof on both clients.

API base: `https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws`

Callback: `/integrations/oauth/ebay/callback` (alias `/oauth/ebay/callback`).

Deletion endpoint: `/integrations/webhooks/ebay/account-deletion`.

Required OAuth scopes: base `api_scope`, `sell.fulfillment.readonly`, `commerce.identity.readonly`.

Production secret reference: `packproof/staging/integrations/ebay/production/app` (the deployment is named staging; the provider keyset is production). Neither secret values nor tokens belong in source control.

## Release verification

Run the focused eBay integration/recovery/signature suites, backend compilation, web production build, and mobile typecheck. New regression coverage exercises fixed Android callbacks and denied-consent state reuse, wrong-seller reconnection without credential replacement, seller renames, credential-removal retries, and buyer import suppression. Shipping fields are imported when present in order instructions; shipping-fulfillment enrichment and eBay live tracking are not implemented. Physical-device consent and real-order verification remain blocked by production activation.

Migration `065_ebay_deletion_cases` must be applied by the existing migration owner before API rollout; grant the runtime role SELECT/INSERT/UPDATE on this operational table. The current deployment uses the database owner login; separate runtime ownership remains operational hardening work. This release does not weaken existing database guards.

## Official references

- https://developer.ebay.com/develop/guides/sell/authorization
- https://developer.ebay.com/develop/guides/sell/marketplace-user-account-deletion
- https://developer.ebay.com/api-docs/master/commerce/identity/openapi/3/commerce_identity_v1_oas3.json
- https://developer.ebay.com/api-docs/master/sell/fulfillment/openapi/3/sell_fulfillment_v1_oas3.json
