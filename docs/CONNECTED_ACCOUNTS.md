# Connected accounts

PackProof links official provider accounts to an existing PackProof user. This is **not** Cognito sign-in and does not replace PackProof authentication.

Clients never store provider tokens. The API stores a `credential_reference` on `connected_accounts` and writes access/refresh material only to the existing integration credential store (`memory`, `env`, or AWS Secrets Manager). Token values are never logged and never returned in REST payloads.

```text
Web / mobile Account
        │  GET /me/connected-accounts
        │  POST /me/connected-accounts/:provider/connect
        ▼
ConnectedAccountProvider registry
  ebay | shopify | google | facebook
        │
        ├── OAuth authorize URL + CSRF state (`oauth_authorization_attempts`)
        ├── GET /oauth/:provider/callback
        ├── encrypted credential store
        └── capabilities { identity, transactions, fulfillment, shipping, webhooks }
```

eBay seller OAuth that already existed (`/me/marketplaces/ebay/*` and `GET /integrations/oauth/ebay/callback`) remains the commerce import path. Successful eBay OAuth dual-writes a `connected_accounts` row so Account and Stores show the same identity.

Shopify install dual-writes an `integration_connections` row so existing commerce sync / fulfillment ingestion can import shop orders without a new ingestion pipeline.

## Provider capability abstraction

Every provider implements `ConnectedAccountProvider`:

- `getAuthorizationUrl`
- `handleCallback`
- `refreshCredentials`
- `getAccountIdentity`
- `disconnect`
- `capabilities` / `limitations`

Domain and UI code use the registry. They do not branch on `if (provider === "ebay")` to decide OAuth.

Statuses: `CONNECTED`, `NEEDS_REAUTH`, `DISCONNECTED`, `ERROR`.

Disconnect revokes the provider token where the official API supports it, deletes stored credentials, and marks the row `DISCONNECTED`.

Audit events (account-scoped, not Proof audit):

- `CONNECTED_ACCOUNT_LINKED`
- `CONNECTED_ACCOUNT_REAUTHORIZED`
- `CONNECTED_ACCOUNT_DISCONNECTED`
- `CONNECTED_ACCOUNT_AUTH_ERROR`

## Supported providers and official API limits

### eBay

| Capability | Supported |
| --- | --- |
| identity | Yes — commerce identity / username |
| transactions | Yes — seller Sell Fulfillment orders via the existing marketplace import |
| fulfillment | Yes — same seller fulfillment path |
| shipping | No |
| webhooks | Yes — marketplace account-deletion notifications already registered |

Official OAuth Authorization Code Grant. RuName is the token `redirect_uri`. Buyer purchase import is not implemented. See [EBAY_INTEGRATION.md](EBAY_INTEGRATION.md).

### Shopify

| Capability | Supported |
| --- | --- |
| identity | Yes — shop id and `*.myshopify.com` domain |
| transactions | Yes — Admin API `read_orders` mapped into existing commerce sync |
| fulfillment | Yes — `read_fulfillments` |
| shipping | No |
| webhooks | Yes — verified `app/uninstalled` |

Official OAuth install. Shop host is restricted to `*.myshopify.com`. One PackProof user may connect multiple shops. Shopify Marketplace / Shop App buyer surfaces are not implemented.

### Google

| Capability | Supported |
| --- | --- |
| identity | Yes — OIDC `sub`, name, email |
| transactions | No |
| fulfillment | No |
| shipping | No |
| webhooks | No |

Official OIDC/OAuth with PKCE and offline refresh. Scopes are `openid email profile` only. **This is not Cognito Hosted UI / Google IdP login.** PackProof authentication remains the existing Cognito (or dev) adapter.

### Meta / Facebook

| Capability | Supported |
| --- | --- |
| identity | Yes — Graph `public_profile` (`id`, `name`) |
| transactions | No |
| fulfillment | No |
| shipping | No |
| webhooks | No |

Official Facebook Login / Graph API. **Facebook Marketplace has no official public API for C2C listings or orders.** PackProof does not fabricate Marketplace import. Instagram/Facebook Shops Catalog Commerce APIs are out of this slice. This is not Cognito Facebook login. Route aliases `meta` and `fb` normalize to `facebook`.

## HTTP API

- `GET /me/connected-accounts` — `{ accounts, providers }` with capabilities and limitations. No tokens.
- `POST /me/connected-accounts/:provider/connect` — Shopify body `{ "shop": "store.myshopify.com" }`. Returns `{ authorizationUrl, expiresAt, provider }`.
- `GET /oauth/:provider/callback` — unauthenticated. eBay still completes through `completeEbayOAuth` because the RuName accepted URL is `/integrations/oauth/ebay/callback`.
- `POST /me/connected-accounts/:id/reauthorize`
- `DELETE /me/connected-accounts/:id`
- `POST /integrations/webhooks/shopify` — HMAC-verified uninstall.

Existing eBay routes are unchanged.

After a successful callback the API redirects the browser to the first `PACKPROOF_WEB_ORIGINS` origin at `/account?connected=<provider>`. eBay continues to return to `/stores?ebay=connected`.

## Environment variables

Set these on the **API** only. Never put client secrets in Vite, Expo, or Git.

### eBay (unchanged)

See [EBAY_INTEGRATION.md](EBAY_INTEGRATION.md). `PACKPROOF_EBAY_*` / `EBAY_*`.

### Shopify

| Variable | Purpose |
| --- | --- |
| `PACKPROOF_SHOPIFY_INTEGRATION_ENABLED=true` | Feature flag. Startup fails if required fields are missing. |
| `PACKPROOF_SHOPIFY_CLIENT_ID` | App client id. Alias: `SHOPIFY_CLIENT_ID`. |
| `PACKPROOF_SHOPIFY_CLIENT_SECRET` | App secret. Stored as `env:PACKPROOF_SHOPIFY_CLIENT_SECRET` in the credential store. |
| `PACKPROOF_SHOPIFY_APP_CREDENTIAL_REFERENCE` | Optional explicit credential reference instead of the env alias. |

### Google

| Variable | Purpose |
| --- | --- |
| `PACKPROOF_GOOGLE_INTEGRATION_ENABLED=true` | Feature flag. |
| `PACKPROOF_GOOGLE_CLIENT_ID` | OAuth client id (web application). |
| `PACKPROOF_GOOGLE_CLIENT_SECRET` | Client secret. |
| `PACKPROOF_GOOGLE_APP_CREDENTIAL_REFERENCE` | Optional explicit credential reference. |

### Meta / Facebook

| Variable | Purpose |
| --- | --- |
| `PACKPROOF_FACEBOOK_INTEGRATION_ENABLED=true` | Feature flag. Alias: `PACKPROOF_META_INTEGRATION_ENABLED`. |
| `PACKPROOF_FACEBOOK_APP_ID` | App id. Alias: `PACKPROOF_META_APP_ID`. |
| `PACKPROOF_FACEBOOK_APP_SECRET` | App secret. Alias: `PACKPROOF_META_APP_SECRET`. |
| `PACKPROOF_FACEBOOK_APP_CREDENTIAL_REFERENCE` | Optional explicit credential reference. |

Credential store: `PACKPROOF_CREDENTIAL_STORE=secrets-manager` in staging/production so user tokens survive process restart. Local tests use memory.

## OAuth redirect URLs to register

Replace `<API>` with `PACKPROOF_PUBLIC_URL` (no trailing slash).

| Provider | Register this exact HTTPS URL |
| --- | --- |
| eBay RuName accepted URL | `https://<API>/integrations/oauth/ebay/callback` |
| eBay alias (optional) | `https://<API>/oauth/ebay/callback` |
| Shopify allowed redirection URL | `https://<API>/oauth/shopify/callback` |
| Google authorized redirect URI | `https://<API>/oauth/google/callback` |
| Facebook Valid OAuth Redirect URI | `https://<API>/oauth/facebook/callback` |

Shopify also needs the webhook: `https://<API>/integrations/webhooks/shopify` (`app/uninstalled`).

Google and Facebook OAuth clients must be **web** clients whose redirect is the API callback, not the Vite or Expo origin. PackProof then redirects the user back to the web Account page (or the user returns to the mobile app, which reloads `GET /me/connected-accounts`).

## Clients

Account → Connected Accounts on web and mobile lists the same canonical `GET /me/connected-accounts` payload. Connect opens the official authorize URL in the browser. Disconnect calls `DELETE /me/connected-accounts/:id`.
