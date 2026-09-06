# Shippo tracking

The `shippo-tracker` trusted adapter imports Shippo tracking observations into a Proof's append-only shipment supplement. It uses server credentials and never accepts provider credentials or trusted carrier assertions from the camera. Existing EasyPost bindings remain usable.

## Runtime configuration

Set `PACKPROOF_CAPTURE_SHIPPO_CREDENTIAL_REFERENCE` to an existing server credential-store reference. Supported stores include `env:PACKPROOF_SHIPPO_CREDENTIALS` for local use and a Secrets Manager reference such as `packproof/staging/integrations/shippo` for deployment. Provision the secret separately; do not commit keys.

Credential material:

```json
{"apiKey":"shippo_test_REPLACE","mode":"test"}
```

Production uses a `shippo_live_` key and `mode: "production"`. The key prefix and configured mode must agree. The provider response must explicitly identify its test/live mode, carrier and requested tracking number. A missing/mismatched identity is rejected before evidence import.

New captured-label jobs prefer Shippo. If a deployment only sets the legacy `PACKPROOF_CAPTURE_EASYPOST_CREDENTIAL_REFERENCE`, that explicit choice still applies. An already-bound transaction is never silently migrated between providers. Credentials stay behind the existing credential store and do not appear in mobile bundles, canonical Proof responses, or integration logs.

## Tracking and simulation

- GET `/tracks/{carrier}/{tracking_number}` supplies immediate status/history and later six-hour polling, without registering webhooks. The Proof's Update tracking action also refreshes it.
- UPS, USPS, FedEx and DHL Express carrier names map to Shippo tokens. Only distinctive UPS/USPS barcode formats auto-select a carrier; ambiguous identifiers require the carrier in shipping information. Additional carriers need an explicit supported-token mapping and carrier restriction review.
- Test keys only permit the documented `SHIPPO_PRE_TRANSIT`, `SHIPPO_TRANSIT`, `SHIPPO_DELIVERED`, `SHIPPO_RETURNED`, `SHIPPO_FAILURE` and `SHIPPO_UNKNOWN` identifiers, with carrier `shippo`. A real captured barcode is never substituted with a simulator number. Its lookup waits for live access while its camera observation remains attached.
- Every imported Shippo observation includes `eventData.test` and `eventData.mode`. Mobile and web identify simulated events visibly, including Proofs created without an in-video scan.
- Status, substatus, carrier scan time, location, action-required flag and available ETA are retained. Scans without a valid provider timestamp are skipped, never assigned the current time.
- Event content determines identity across polling and webhooks. Provider corrections append new observations; exact repeats do not add rows. Current status and history copies of the same scan are deduplicated even if Shippo assigns different object IDs.
- `RETURNED` means returning or returned; it maps to `RETURN_TO_SENDER`, does not assert return delivery, and does not stop polling.
- Weight is imported only when actually present, with its supplied supported unit and carrier-reported provenance. Alternate unit representations are treated as one observation. Its timestamp is explicitly marked as based on tracking status, not an independently reported weighing time. Shippo documents weight/dimensions on UPS/FedEx POST responses only; GET polling and webhooks do not promise these details. Dimensions are not imported by this version.

## Optional signed webhooks

Shippo HMAC currently requires account-manager/sales setup; polling avoids making that a prerequisite. After Shippo enables HMAC, configure a `track_updated` webhook for the correct mode at:

```text
https://YOUR_API_HOST/integrations/webhooks/shippo-tracker
```

Put the shared HMAC secret in credential material as `webhookSecret` and set the string `registerWebhooks` to `"true"` only after the subscription is configured. The adapter then POSTs `/tracks/` once per persisted mode/carrier/tracking cursor and requests optional package details. Subsequent refreshes GET the tracking resource.

Shippo registration is not idempotent. A lost response or crash before cursor persistence can cause a duplicate remote registration; leases prevent ordinary concurrent registration, and event-content deduplication prevents duplicate evidence from repeated notifications. Switching webhook subscriptions requires explicit operational re-registration; it is not inferred from a changed secret.

`Shippo-Auth-Signature: t=...,v1=...` is checked using HMAC-SHA256 of `timestamp.rawBody`, constant-time comparison, and a five-minute timestamp window. Unsigned, altered, wrong-mode, wrong-carrier and unbound tracking updates are rejected. No URL-token fallback or client-supplied provenance is accepted.

## Verification

`npm test -- tests/shippo-tracking.test.ts tests/capture-shipping.test.ts` covers normalization, identity/mode isolation, provider errors, HMAC/replay, durable retries, capture binding, canonical Proof import and poll/webhook deduplication. The existing frozen-manifest and mobile offline-queue tests remain relevant.

An opt-in test in `shippo-tracking.test.ts` uses `SHIPPO_SANDBOX_TEST_TOKEN` (a test token for a real network call) to fetch Shippo sandbox data through the adapter and import it through the HTTP shipment-sync route into a disposable local Proof. Never set this variable in ordinary CI or commit its value.

On 2026-09-06, the user's supplied test token returned HTTP 200 with `test: true`, carrier `shippo`, tracking `SHIPPO_TRANSIT`, and transit history. This verifies sandbox access, not live-carrier access or deployed application configuration.

Primary references: [authentication](https://docs.goshippo.com/guides/authentication), [tracking API and test numbers](https://docs.goshippo.com/tracking/tracking), [webhook security and HMAC](https://docs.goshippo.com/tracking/webhook-security).
