# eBay marketplace integration

PackProof treats eBay as a **connected marketplace**, not a PackProof sign-in identity.

## What this slice does

Authenticated sellers can:

1. Connect an eBay account through OAuth Authorization Code Grant (RuName as `redirect_uri`).
2. List recent checkout-completed seller orders from the Sell Fulfillment API.
3. Import a selected order into the existing `ImportedTransaction` path and create-or-get the canonical Proof.

Refresh tokens are stored only in the server credential store. They are never returned to web or mobile clients.

Per-connection user tokens use a credential **reference** on `integration_connections` (not the token values). The reference looks like:

`packproof/<packproof-env>/integrations/ebay/<sandbox|production>/<connectionId>`

When `PACKPROOF_CREDENTIAL_STORE=secrets-manager`, `CompositeCredentialStore.put()` writes that secret to AWS Secrets Manager (CreateSecret / PutSecretValue) and reads it back after process restart. Memory is only a cache. Disconnect and marketplace-deletion handling delete the stored secret.

Local `env` / `memory` stores still keep user tokens in process memory. Staging/production must use `secrets-manager` for restart survival.

## Required server configuration

Set these on the API only:

| Variable | Purpose |
| --- | --- |
| `PACKPROOF_EBAY_INTEGRATION_ENABLED=true` | Feature flag. Default off. Startup fails if required fields are missing. |
| `PACKPROOF_EBAY_ENVIRONMENT` | `sandbox` or `production`. Sandbox App IDs cannot be paired with production. |
| `PACKPROOF_EBAY_CLIENT_ID` | App ID |
| `PACKPROOF_EBAY_CLIENT_SECRET` | Cert ID (OAuth client secret) |
| `PACKPROOF_EBAY_DEV_ID` | Dev ID (not sent to clients; not required for Sell Fulfillment) |
| `PACKPROOF_EBAY_RUNAME` | RuName generated in the eBay Developer Portal |
| `PACKPROOF_EBAY_MARKETPLACE_ID` | Default `EBAY_US` |
| `PACKPROOF_EBAY_DELETION_VERIFICATION_TOKEN` | Token registered for marketplace deletion |

`EBAY_*` aliases are accepted. Do not put `EBAY_CLIENT_SECRET` in Vite, Expo, `app.config.js`, or Git.

If the flag is enabled without Client ID, RuName, and client secret (or `PACKPROOF_EBAY_APP_CREDENTIAL_REFERENCE`), the API process refuses to start. The error does not include secret values.

OAuth scopes requested:

- `https://api.ebay.com/oauth/api_scope`
- `https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly`
- `https://api.ebay.com/oauth/api_scope/commerce.identity.readonly`

Redirect URI on eBay's token exchange is the **RuName**, not a PackProof URL. PackProof's callback is `GET /integrations/oauth/ebay/callback`. Register that HTTPS URL as the RuName's accepted URL.

Sandbox hosts: `auth.sandbox.ebay.com`, `api.sandbox.ebay.com`. Production hosts: `auth.ebay.com`, `api.ebay.com`.

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

- deletes stored OAuth credentials for that connection
- disables the marketplace connection
- anonymizes the stored eBay display reference
- does **not** delete Proofs, evidence bytes, manifests, or audit events

Those records are evidentiary. Provider account data and immutable PackProof records are separate.

**POST notification signature verification against eBay's Notification API public keys is still required before production enablement.** Do not fake signature validation. The current POST handler acknowledges the notification id and disables matching connections without verifying an eBay signature.

## Transaction identity

Seller Fulfillment `orderId` is the canonical external transaction id. Tenant key is `marketplace:ebay:<environment>` so sandbox and production cannot collide.

eBay documents the REST order id as globally unique and used by both seller and buyer. Buyer import is not implemented in this slice. Do not assume a Trading API buyer identifier matches until that path is instrumented against live responses.

Re-importing the same authenticated seller order returns the existing transaction and Proof.

Seller-imported eBay orders use the existing merchant participation policy (`COUNTERPARTY_OPTIONAL`) so a seller can capture fulfillment evidence and finalize without a PackProof buyer account. This is not an eBay-specific Proof model.

Missing eBay fields are stored as null / omitted. PackProof does not invent buyer names, prices, tracking numbers, or shipping services.

## Demo marketplace

`demo-marketplace` remains a reference adapter for tests and `__DEV__`. It is not the production Import purchase path. When eBay is enabled and not connected, Create shows Connect eBay.

## Manual live Sandbox checklist

Do this only after Client ID, Cert ID, Dev ID, and RuName are in **server** env (never in Git):

- [ ] `PACKPROOF_EBAY_INTEGRATION_ENABLED=true`
- [ ] `PACKPROOF_EBAY_ENVIRONMENT=sandbox`
- [ ] RuName accepted URL is `https://<API>/integrations/oauth/ebay/callback`
- [ ] Staging uses `PACKPROOF_CREDENTIAL_STORE=secrets-manager`
- [ ] eBay Sandbox account authorization succeeds
- [ ] callback returns to PackProof `/stores?ebay=connected`
- [ ] marketplace connection appears
- [ ] reload retains connection
- [ ] server restart retains connection (Secrets Manager mode)
- [ ] real seller order list appears
- [ ] no Vintage Film Camera fixture appears
- [ ] select real order
- [ ] actual eBay values shown; missing fields omitted
- [ ] provenance says eBay
- [ ] Create PackProof succeeds
- [ ] Proof reload succeeds
- [ ] re-import same eBay order opens existing Proof
- [ ] seller video capture succeeds
- [ ] evidence uploads
- [ ] SHA-256 commit succeeds
- [ ] Evidence secured only after server commit
- [ ] packing attestation + finalize succeeds
- [ ] finalized Proof reloads
- [ ] chronology contains eBay-supplied import vs PackProof-recorded evidence

This repository's automated tests do **not** prove a live Sandbox OAuth session. That still requires a real eBay account.
