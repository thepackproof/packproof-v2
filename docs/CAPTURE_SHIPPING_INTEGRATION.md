# In-video shipping → Shippo → Proof

Android release 0.3.1 / version code 30 uses the `shipping-integration` EAS profile to enable the unified recorder and label integration. Against an older API without the label route, the recorder shows that autofill is unavailable and allows video submission; it does not claim the label was attached. Authentication, session, and network failures retain the normal retry behavior. Shippo carrier enrichment still requires the updated backend and its server-side credentials.

The user reported successful S24 Ultra simultaneous video/barcode capture with haptic and visual feedback on September 5, 2026. This implementation connects that recorder to the normal server-authorized packing flow. The standalone diagnostic APK remains separate.

## Behavior

- Android normal packing uses the unified camera when `EXPO_PUBLIC_PACKPROOF_IN_VIDEO_SHIPPING=true` and the native module is available. iOS, older binaries, receipt/return stages, and grading retain their existing camera paths. Normal recordings remain silent, at most three minutes, with a 195 MiB native limit below the backend's 200 MiB limit.
- The camera forwards bounded barcode observations to a separate queue. The queue writes an account/Proof/session-scoped journal before sending the API request. Repeated codes reuse the first retry key and timestamp. Network and authentication failures do not stop recording. Saved-capture submission replays pending requests before finalization; it retains the video locally if connection recovery is still needed.
- `POST /proofs/:id/capture-sessions/:sessionId/shipping-label` authenticates the seller and native packing session, uses the seven-day recovery window, and locks the transaction before its Proof/session. Exact successful retries remain readable after finalization. New post-finalization observations are rejected.
- UPS `1Z` and supported 22-digit USPS `92`–`95` families can attach automatically. Supported concatenated USPS `420` + five/nine-digit routing prefixes are removed. Other 10–26-character identifiers require an explicit confirmation unless they exactly match existing tracking. UPC/EAN and rich QR payloads are filtered by the native client. Unsupported long FedEx composite payloads require the existing shipping fallback; they are never guessed or truncated into a tracking number.
- A different tracking number is a conflict. An append-only camera observation and audit event retain the video offset, session, format, normalized tracking identity, carrier hint, and whether the participant confirmed it. Database guards also prevent later shipping edits/imports from replacing captured tracking.
- Committed video is correlated through its original capture session. The Proof shows the captured label and approximate offset, a replay button, and the carrier registration state. Device recognition/timing remains **client-reported**, separate from carrier observations.
- The packing-station finish scan/manual finish flow remains available. Removing its mandatory scan prompt awaits the extended hardware acceptance matrix.

## Carrier processing

Migration `032_capture_shipping` adds a durable job per transaction. The worker runs every 15 seconds, with a two-minute PostgreSQL lease across replicas. It reuses an existing bound integration, otherwise the seller's sole active Shippo connection, otherwise an explicitly configured server Shippo credential reference. An explicitly configured legacy EasyPost reference remains supported when no Shippo reference is configured. It never silently chooses between multiple seller connections or rebinds an existing transaction connection.

Provider calls run outside database transactions and outside recording. Temporary failures back off, with eight attempts before attention is required. Missing credentials/connections, test-only access for a real label, and missing carriers wait and retry hourly without exhausting that budget. Successful nonterminal trackers refresh every six hours. Shippo polling works without webhook setup; authenticated webhooks can provide intervening updates after account configuration. Returns continue refreshing because Shippo's RETURNED status also covers packages still heading back. The normal **Update tracking** action can retry a failed lookup once an integration is bound.

Shippo's tracking API supports individual lookups for supported labels purchased elsewhere. Returned tracking identity, carrier and production/test mode are checked before import. UPS and USPS have conservative barcode-based carrier detection; ambiguous numbers require an explicitly selected supported carrier in shipping information. Status, scan time/location and available estimated delivery use the existing append-only `shipment_events` and shipment integrity supplement. Optional carrier-reported weight is imported when present; Shippo documents package details for UPS/FedEx tracking POST responses only, so polling alone does not promise weight. Carrier observations arriving later do not modify the frozen core manifest. A successful lookup alone does not prove carrier possession or delivery.

References: [Shippo tracking](https://docs.goshippo.com/tracking/tracking), [Shippo integration runbook](SHIPPO_TRACKING_INTEGRATION.md), [USPS concatenated routing barcode standards](https://pe.usps.com/text/dmm300/204.htm).

## Activation

1. Deploy the backend/migration and web changes using the repository's reviewed staging deployment path.
2. Provision the Shippo credential material in the existing server credential store. Prefer the deployment's Secrets Manager reference. For local development the `env:` store accepts JSON containing `apiKey` and `mode` (`test` or `production`). No key belongs in the mobile bundle, source, or a client request.
3. Set `PACKPROOF_CAPTURE_SHIPPO_CREDENTIAL_REFERENCE` to that server-side reference (for example `packproof/staging/integrations/shippo`). This is optional when the seller already has exactly one active Shippo connection. `PACKPROOF_CAPTURE_SHIPMENT_WORKER=false` disables the background worker.
4. Polling requires no webhook. Optionally configure Shippo's signed webhook at `/integrations/webhooks/shippo-tracker`, following [the Shippo runbook](SHIPPO_TRACKING_INTEGRATION.md).
5. Build the full app with `eas build --platform android --profile shipping-integration`. This opt-in profile inherits the normal Play package, Cognito/API configuration, remote signing credentials, and **AAB** format. Increment the Android version code before a new Play upload if code 29 is already used. The normal `internal-staging` profile keeps the feature off. Never enable the standalone camera-spike flag for either Play profile.
6. Run a real-label smoke test with live Shippo credentials, then complete the S24/A16 extended matrix before wider rollout. Shippo test responses remain visibly marked as simulated data; the supplied test token cannot enrich a real captured label.

## Validation / remaining external gates

- Targeted backend + mobile queue regression: 28 passed, one existing credential-gated live EasyPost test skipped.
- Additional transaction/Proof contract and packing submission regressions: 19 passed. Queue storage/auth-renewal regression: passed.
- Native HTTP contract test includes the new shipping endpoint, original capture upload/retry, replay, and case export: passed.
- Backend and mobile TypeScript: passed.
- Web production build and normal Android Metro export with the shipping flag enabled: passed.
- Shippo test API access was verified on 2026-09-06. The actual sandbox response was imported into a disposable local Proof through the normal shipment-sync HTTP route. Production API access, deployed server credential configuration, and a newly signed full-app AAB remain rollout gates. The previously tested APK is the standalone camera diagnostic, not this integration build.

Crash recovery guarantees apply to a saved capture and its persisted journal. A process killed before MP4 finalization may leave an incomplete recording; this feature does not claim continuous capture through process death. Full label images, addresses, provider keys and raw provider response bodies are not stored in the scan observation or application logs.
