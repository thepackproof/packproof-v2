# eBay marketplace integration

PackProof treats eBay as a **connected marketplace**, not a PackProof sign-in identity.

## What this slice does

Authenticated sellers can:

1. Connect an eBay account through OAuth Authorization Code Grant (RuName as `redirect_uri`).
2. List recent checkout-completed seller orders from the Sell Fulfillment API.
3. Import a selected order into the existing `ImportedTransaction` path and create-or-get the canonical Proof.

Refresh tokens are stored only in the server credential store. They are never returned to web or mobile clients.

Per-connection user tokens currently persist through `CompositeCredentialStore.put()`, which writes **process memory only**. Secrets Manager is GetSecretValue today. Staging/production that must survive process restarts still need a durable `put` (or equivalent) before treating eBay connections as production-ready across deploys.

## Required server configuration

Set these on the API only:

| Variable | Purpose |
| --- | --- |
| `PACKPROOF_EBAY_INTEGRATION_ENABLED=true` | Feature flag. Default off. |
| `PACKPROOF_EBAY_ENVIRONMENT` | `sandbox` or `production` |
| `PACKPROOF_EBAY_CLIENT_ID` | App ID |
| `PACKPROOF_EBAY_CLIENT_SECRET` | Cert ID (OAuth client secret) |
| `PACKPROOF_EBAY_DEV_ID` | Dev ID (not sent to clients) |
| `PACKPROOF_EBAY_RUNAME` | RuName generated in the eBay Developer Portal |
| `PACKPROOF_EBAY_MARKETPLACE_ID` | Default `EBAY_US` |
| `PACKPROOF_EBAY_DELETION_VERIFICATION_TOKEN` | Token registered for marketplace deletion |

`EBAY_*` aliases are accepted. Do not put `EBAY_CLIENT_SECRET` in Vite, Expo, `app.config.js`, or Git.

OAuth scopes requested:

- `https://api.ebay.com/oauth/api_scope`
- `https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly`
- `https://api.ebay.com/oauth/api_scope/commerce.identity.readonly`

Redirect URI on eBay's token exchange is the **RuName**, not a PackProof URL. PackProof's callback is `GET /integrations/oauth/ebay/callback`. Register that HTTPS URL as the RuName's accepted URL.

## Production keyset / marketplace account deletion

eBay will not enable a Production keyset until the application either:

1. Exposes a Marketplace Account Deletion/Closure notification endpoint, or
2. Completes the Developer Portal exemption/opt-out if PackProof is not persisting eBay user data.

PackProof **does** store a connected eBay user id/username on `integration_connections`. Implement the portal step:

1. Developer Portal → Application Keys → Production → Notifications.
2. Register `https://<PACKPROOF_PUBLIC_URL>/integrations/webhooks/ebay/account-deletion`.
3. Register the same verification token as `PACKPROOF_EBAY_DELETION_VERIFICATION_TOKEN`.
4. Pass eBay's GET challenge. This API answers `{ challengeResponse }` as SHA-256(`challengeCode + verificationToken + endpoint`).

Do not disable this requirement in code.

### What PackProof deletes vs keeps

When eBay notifies that a user closed their account, PackProof:

- disables the marketplace connection
- anonymizes the stored eBay display reference
- does **not** delete Proofs, evidence bytes, manifests, or audit events

Those records are evidentiary. Provider account data and immutable PackProof records are separate.

POST notification signature verification against eBay's Notification API public keys is still required before calling this production-complete. The current handler acknowledges the notification id and disables matching connections.

## Transaction identity

Seller Fulfillment `orderId` is the canonical external transaction id. Tenant key is `marketplace:ebay:<environment>` so sandbox and production cannot collide.

eBay documents the REST order id as globally unique and used by both seller and buyer. Buyer import is not implemented in this slice. Do not assume a Trading API buyer identifier matches until that path is instrumented against live responses.

## Demo marketplace

`demo-marketplace` remains a reference adapter for tests and `__DEV__`. It is not the production Import purchase path once eBay is enabled.
