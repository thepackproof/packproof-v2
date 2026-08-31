# Trusted shipment integrations

This repository does not connect to UPS, FedEx, USPS, DHL, or Shippo. It does register a trusted EasyPost **Tracker** adapter (`easypost-tracker`) for **test/staging tracking observations**. That adapter is not a production EasyPost rollout and does not buy labels. See [EASYPOST_TRACKING_INTEGRATION.md](EASYPOST_TRACKING_INTEGRATION.md).

```text
PARTICIPANT / CLIENT
        │
        │ cannot claim trusted carrier provenance
        ▼
    PackProof participant API
TRUSTED SERVER INTEGRATION
        │
        │ server-owned credentials + adapter
        ▼
Trusted carrier runtime
        │
        ▼
Normalized shipment observations
        │
        ▼
Existing importShipmentObservations()
        │
        ▼
Append-only shipment_events
```

## Three paths

| Path | Who is trusted | Provenance | Route |
| --- | --- | --- | --- |
| Participant observation | Joined participant | Always `PARTICIPANT_SUPPLIED` / `provider: participant` | `POST /transactions/:id/shipment-events` |
| Reference adapter | Authenticated seller asking PackProof to run a **reference** adapter | Server-assigned from the adapter output (`demo-carrier`) | `POST /integrations/shipment-events/import` `mode: "reference"` |
| Trusted adapter | Server-side adapter + credential store | Always `SHIPPING_PROVIDER_API` and the adapter’s `provider` | `POST /transactions/:id/shipment-sync` or `POST /integrations/webhooks/:adapterKey` |

Clients cannot choose `source`, `provider`, adapter output, or credentials on the trusted path. Request JSON does not decide trusted provenance.

Adapter kinds currently registered:

| Adapter | Kind | Role |
| --- | --- | --- |
| `demo-carrier` | `reference` | Development fixture. Not a carrier. |
| `trusted-demo-carrier` | `trusted` | Fake trusted harness for tests. Not a live provider. |
| `easypost-tracker` | `trusted` | Real EasyPost Tracker adapter. Test/staging capable. `provider = easypost`. Underlying `carrier` (UPS, etc.) is preserved when EasyPost reports it. |

## Trust boundary

A browser or mobile app that posts `{ source: "SHIPPING_PROVIDER_API", provider: "UPS" }` still stores `PARTICIPANT_SUPPLIED` / `participant`. Extra `source` / `provider` keys in `eventData` are stripped.

`POST /integrations/shipment-events/import` rejects `kind: "trusted"` adapters (`INTEGRATION_TRUST_BOUNDARY`). There is no participant route that accepts arbitrary normalized carrier events as trusted.

Webhook bodies are verified before they are parsed into observations. The webhook route does not accept a PackProof shipment-event JSON document as a shortcut.

## Credentials

The domain never reads environment variables, AWS Secrets Manager, SSM, files, or Expo/Vite config directly.

```ts
interface IntegrationCredentialStore {
  getCredentials(input: {
    adapterKey: string;
    credentialReference: string;
    connectionId?: string;
  }): Promise<IntegrationCredentials | null>;
}
```

`IntegrationCredentials.material` is opaque to the shipment-event domain. Adapters receive it only inside the trusted runtime.

Implementations:

- `MemoryCredentialStore` — tests and in-process seeds
- `EnvCredentialStore` — `credential_reference` `env:VAR_NAME` reads that process env var (JSON object or a bare API key)
- `SecretsManagerCredentialStore` — `credential_reference` is a secret ARN, `sm:name`, or `packproof/...` name. The ECS **task role** (not the execution role) must allow `secretsmanager:GetSecretValue` on `arn:aws:secretsmanager:REGION:ACCOUNT:secret:packproof/staging/integrations/*`. Staging EasyPost uses `packproof/staging/integrations/easypost`. No static AWS keys in source.

`PACKPROOF_CREDENTIAL_STORE=memory|env|secrets-manager` (default `env`). The composite store still consults memory first so development seeding works.

Secrets must not appear in API JSON, `transaction_metadata`, `event_data`, manifests, supplements, audit records, client-visible errors, CloudWatch logs, `web/` env, or Expo public env.

## Integration connections

Migration `010_trusted_shipment_integrations.sql`.

`integration_connections` stores owner, `adapter_key`, `provider`, optional `external_account_reference`, **credential_reference** (not the secret), and status `ACTIVE` | `DISABLED` | `NEEDS_REAUTH`.

`transaction_shipment_connections` binds one connection to a transaction (`UNIQUE(transaction_id)`).

`shipment_sync_states` records last attempt/success and a retryable error category. No secrets. No job runner.

`integration_webhook_receipts` stores `(adapter_key, provider_event_id)` for replay protection.

There is no production connection-management UI and no OAuth flow in this slice.

## Trusted adapter contract

```ts
interface TrustedShipmentAdapter {
  adapterKey: string;
  kind: "trusted";
  provider: string;
  getTrackingSnapshot(input: {
    trackingNumber: string;
    transactionId: string;
    externalTransactionId: string | null;
    carrier?: string | null;
    providerCursor?: string | null;
    credentials: IntegrationCredentials;
  }): Promise<TrustedTrackingSnapshot>;
  verifyWebhook(input: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: Buffer;
    credentials: IntegrationCredentials;
  }): Promise<VerifiedWebhookResult>;
}
```

Provider HTTP, OAuth, and response XML/JSON stay inside the adapter. `importShipmentObservations` never sees UPS/FedEx/Shippo shapes.

## Trusted sync

`executeTrustedShipmentSync({ transactionId })`:

1. Authorize a joined participant (or the seller before a Proof exists).
2. Load the bound connection.
3. Reject `DISABLED` / `NEEDS_REAUTH`.
4. Resolve a `kind: "trusted"` adapter.
5. Load credentials by reference.
6. Call `getTrackingSnapshot`.
7. Overwrite `source = SHIPPING_PROVIDER_API` and `provider = adapter.provider`.
8. Insert through the existing append-only shipment-event domain (idempotent on provider event id).
9. Record sync state. Append `SHIPMENT_SYNC_COMPLETED` only when new observations were created.

`POST /transactions/:id/shipment-sync` accepts an empty JSON object only. Extra keys are `INTEGRATION_TRUST_BOUNDARY`.

Scheduling (cron, EventBridge, SQS, Lambda) is out of scope. The same function is what a future worker would call.

## Webhooks

`POST /integrations/webhooks/:adapterKey` is unauthenticated. It uses the raw body.

Webhook verification is adapter-specific:

- `trusted-demo-carrier` (test-only): HMAC-SHA256 of `timestamp + "." + rawBody` with `webhookSecret`, headers `x-packproof-webhook-timestamp` (unix seconds) and `x-packproof-webhook-signature`. Timestamps older than 5 minutes are `WEBHOOK_REPLAY_REJECTED`. That scheme is not production security.
- `easypost-tracker`: EasyPost `X-Hmac-Signature` (`hmac-sha256-hex=…`) over the raw body using the current official HMAC scheme. Unsigned events are rejected when a webhook secret is configured. See [EASYPOST_TRACKING_INTEGRATION.md](EASYPOST_TRACKING_INTEGRATION.md).

After verification, PackProof looks up the transaction by tracking number + adapter binding. Duplicate `provider_event_id` receipts are idempotent (`replayed: true`). Shipment-event unique constraints remain the second line of defense.

## Errors and retryability

| Code | Retryable |
| --- | --- |
| `INTEGRATION_NOT_FOUND` | no |
| `INTEGRATION_DISABLED` | no |
| `INTEGRATION_NEEDS_REAUTH` | no |
| `INTEGRATION_CREDENTIALS_UNAVAILABLE` | yes |
| `PROVIDER_AUTH_FAILED` | no |
| `PROVIDER_RATE_LIMITED` | yes |
| `PROVIDER_TEMPORARILY_UNAVAILABLE` | yes |
| `TRACKING_NOT_FOUND` | no |
| `PROVIDER_RESPONSE_INVALID` | no |
| `WEBHOOK_SIGNATURE_INVALID` | no |
| `WEBHOOK_REPLAY_REJECTED` | no |
| `INTEGRATION_TRUST_BOUNDARY` | no |

No automated retry scheduler. `error.retryable` is for a future worker.

## How a future live provider plugs in

EasyPost Trackers are implemented as `easypost-tracker`. UPS/FedEx/USPS/DHL/Shippo are still future work.

1. Implement `TrustedShipmentAdapter` with `kind: "trusted"`.
2. Keep HTTP, OAuth, and pagination inside the adapter.
3. Store secrets in Secrets Manager; put the name/ARN in `credential_reference`.
4. Register the adapter on `IntegrationAdapterRegistry`.
5. Create an `ACTIVE` connection and bind it to the transaction.
6. Call `executeTrustedShipmentSync` or receive verified webhooks.

Do not teach `shipment_events` UPS XML or EasyPost tracker JSON.

## Clients

Web and mobile may show **Sync shipment** when `proof.shipmentSync.available` is true. When `provider` is `easypost`, the label is **Tracking via EasyPost** (test/staging wording). Timeline titles keep the underlying carrier; source metadata says **Carrier observation via EasyPost**.

Development-only **Connect trusted demo** calls `POST /dev/integrations/trusted-demo/connect` when the API has `PACKPROOF_DEV_AUTH=true`. Local EasyPost binding is `POST /dev/integrations/easypost/connect` with a credential *reference* only. Those routes are not registered in Cognito staging/production mode.

Clients never send trusted provenance, provider payloads, or secrets. Clients never call EasyPost.
