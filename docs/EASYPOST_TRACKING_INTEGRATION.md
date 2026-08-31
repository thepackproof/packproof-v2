# EasyPost tracking integration

EasyPost is a **trusted shipment adapter**, not PackProof domain state. PackProof records carrier observations that EasyPost reports. It does not buy labels, rate shipments, or claim that a delivery was independently verified.

This adapter is **test/staging capable**. It is not a production EasyPost rollout.

```text
External EasyPost Tracker
        ↓
easypost-tracker adapter
        ↓
SHIPPING_PROVIDER_API + provider=easypost
        ↓
importShipmentObservations()
        ↓
append-only shipment_events
```

`source = SHIPPING_PROVIDER_API`  
`provider = easypost`  
`carrier = UPS` (or whatever EasyPost reports as the underlying carrier)

Do not rewrite `provider` to UPS because the package is on UPS.

## TEST vs production mode

Credential JSON:

```json
{
  "apiKey": "<EasyPost TEST key>",
  "webhookSecret": "<webhook HMAC secret>",
  "mode": "test"
}
```

`mode` defaults to `test`. A production-looking API key prefix (`EZAK…`) is rejected while `mode` is `test`. A Tracker or Event with `mode: "production"` is rejected unless the connection is explicitly `mode: "production"`.

Staging must use EasyPost **TEST MODE**. Do not enable production charges from this slice.

## Tracker flow

PackProof never creates EasyPost Shipments. Given a PackProof tracking number and optional known carrier:

1. If `shipment_sync_states.provider_cursor` is an EasyPost `trk_…` id, GET that Tracker.
2. Otherwise POST `/v2/trackers` with `tracking_code` and optional `carrier`. EasyPost returns an existing Tracker when the same user submitted the same code+carrier within three months.

The Tracker id is stored only as a provider-neutral `provider_cursor`. It is not canonical shipment identity.

Official test tracking codes (from [EasyPost Tracker docs](https://docs.easypost.com/docs/trackers)):

| Code | Simulated status |
| --- | --- |
| EZ1000000001 | pre_transit |
| EZ2000000002 | in_transit |
| EZ3000000003 | out_for_delivery |
| EZ4000000004 | delivered |
| EZ5000000005 | return_to_sender |
| EZ6000000006 | failure |
| EZ7000000007 | unknown |

## Status normalization

| EasyPost status | PackProof type |
| --- | --- |
| pre_transit | LABEL_CREATED |
| in_transit | IN_TRANSIT |
| out_for_delivery | OUT_FOR_DELIVERY |
| delivered | DELIVERED |
| return_to_sender | RETURN_TO_SENDER |
| failure | DELIVERY_EXCEPTION |
| unknown / cancelled / available_for_pickup / other | CARRIER_EVENT |

Scan `status_detail` may refine IN_TRANSIT scans (for example `arrived_at_facility` → ARRIVED_AT_FACILITY). Historical `tracking_details` are preferred over the top-level Tracker status. Each useful scan is one observation.

## Source-event identity

TrackingDetail objects have no documented stable id. PackProof derives `easypost:<trackerId>:td:<sha256 of datetime|status|status_detail|message|location>` so retries stay idempotent. Array index and wall clock are not used.

## Weight

EasyPost Tracker `weight` is carrier-reported ounces. When it is a finite number greater than zero, PackProof appends `WEIGHT_RECORDED` with `{ value, unit: "oz", reportedBy: "carrier", via: "easypost" }`. PackProof does not convert units or claim it weighed the package.

## HTTP transport

A narrow `EasyPostTrackerClient` wraps POST/GET `/v2/trackers`. The official EasyPost Node SDK is **not** a domain dependency. SDK types never enter `shipment_events`.

## Webhook HMAC

EasyPost sends `X-Hmac-Signature: hmac-sha256-hex=<digest>`.

PackProof matches the current official Node helper (`Utils.validateWebhook`): HMAC-SHA256 of the raw body (with the documented integer-`weight` float correction) using the NFKD-normalized webhook secret, compared with `timingSafeEqual`. JSON is parsed **after** verification. Unsigned requests are rejected when a webhook secret is configured (required for this adapter).

This is not the fake `trusted-demo-carrier` scheme.

Webhook receipt identity is the EasyPost Event `id` (`evt_…`). EasyPost retries are normal; PackProof stays idempotent.

Return 2XX after synchronous import. No queue in this slice.

## Errors

| EasyPost | PackProof | Retryable |
| --- | --- | --- |
| 401/403 | PROVIDER_AUTH_FAILED | no |
| 429 | PROVIDER_RATE_LIMITED | yes |
| 5xx / timeout | PROVIDER_TEMPORARILY_UNAVAILABLE | yes |
| 404 / NOT_FOUND | TRACKING_NOT_FOUND | no |
| malformed / unexpected production mode | PROVIDER_RESPONSE_INVALID | no |
| bad HMAC / missing signature | WEBHOOK_SIGNATURE_INVALID | no |

Raw EasyPost error bodies are not returned to clients. Operators may mark a connection `NEEDS_REAUTH` after confirmed credential rejection; the runtime does not auto-flip status (that would break test harnesses that reuse a connection).

## Secrets Manager (staging)

1. Create secret name `packproof/staging/integrations/easypost` (or use the full ARN).
2. SecretString JSON as above. Never put the value in git, CloudFormation outputs, ECS environment variables, or clients.
3. `integration_connections.credential_reference` = `packproof/staging/integrations/easypost` (or `arn:aws:secretsmanager:…`).
4. ECS **task role** `packproof-v2-staging-task` has `secretsmanager:GetSecretValue` on `arn:aws:secretsmanager:REGION:ACCOUNT:secret:packproof/staging/integrations/*`.
5. The task **execution** role only reads the RDS master-user secret for injected `PACKPROOF_DB_USER` / `PACKPROOF_DB_PASSWORD`. Application SDK calls do not use the execution role.
6. Set `PACKPROOF_CREDENTIAL_STORE=secrets-manager` on the API task (already in `infra/api-service.yaml`).

Default AWS Secrets Manager encryption uses the AWS-managed key; no extra KMS statements are added.

## Operator: bind a staging connection

Cognito staging does not register `/dev/*` routes. After the secret exists, as a database operator (not from a browser):

```sql
INSERT INTO integration_connections (
  id, owner_user_id, adapter_key, provider, external_account_reference,
  credential_reference, status, created_at, updated_at
) VALUES (
  'icn_easypost_staging',
  '<seller user_… id>',
  'easypost-tracker',
  'easypost',
  NULL,
  'packproof/staging/integrations/easypost',
  'ACTIVE',
  NOW(),
  NOW()
);

INSERT INTO transaction_shipment_connections (transaction_id, connection_id, created_at)
VALUES ('<txn_…>', 'icn_easypost_staging', NOW())
ON CONFLICT (transaction_id) DO UPDATE SET connection_id = EXCLUDED.connection_id;
```

Local development (`PACKPROOF_DEV_AUTH=true`):

`POST /dev/integrations/easypost/connect` with `{ "transactionId", "credentialReference" }` only. Clients must not send `apiKey` or `webhookSecret`.

## EasyPost test webhook

In the EasyPost dashboard (TEST MODE), create a webhook:

- URL: `https://<staging-api-host>/integrations/webhooks/easypost-tracker`
- HTTPS required
- Set `webhook_secret` to the same value stored in Secrets Manager
- Do not publish that secret

## Smoke test (when a TEST key already exists)

Do not invent or commit credentials.

1. Import or create a transaction whose tracking number is an official EasyPost test code (for example `EZ2000000002`, then `EZ3000000003` / `EZ4000000004`).
2. Create the Proof.
3. Provision an ACTIVE `easypost-tracker` connection pointing at the Secrets Manager reference.
4. `POST /transactions/:id/shipment-sync` with `{}`.
5. Confirm `provider=easypost`, `source=SHIPPING_PROVIDER_API`, underlying `carrier` retained, no secrets in the response.
6. Capture/commit evidence, finalize, record core manifest SHA.
7. Sync again or receive a test webhook.
8. Confirm events may append after `FINALIZED`, core SHA unchanged, shipment supplement digest changes, integrity remains valid.
9. Repeat; confirm no duplicate canonical rows.
10. Check web and Android chronology: carrier in the title (for example UPS), source label **Carrier observation via EasyPost**. PackProof did not verify delivery.

## Production-enablement checklist (not done)

- Dedicated production secret namespace and IAM
- EasyPost production key and webhook
- Explicit `mode: "production"`
- Operator verification of live carrier scans
- Do not treat this commit as production support

## Security guarantees

Participants cannot assign `provider=easypost` or `SHIPPING_PROVIDER_API`. The reference import route cannot run `easypost-tracker`. Credentials stay in the credential store. Clients never call EasyPost.

## Known limitations

- Tracking only. No labels, rates, insurance, pickups, or billing.
- No scheduled polling. Manual sync + webhooks.
- Test/staging only until the production checklist is completed.
- Tracker id reuse follows EasyPost’s three-month create/get behavior.
- Webhook processing is synchronous; a queue is a later slice if EasyPost’s response-time expectation cannot be met.
