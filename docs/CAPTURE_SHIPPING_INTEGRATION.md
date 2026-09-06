# In-video shipping → EasyPost → Proof

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

Migration `032_capture_shipping` adds a durable job per transaction. The worker runs every 15 seconds, with a two-minute PostgreSQL lease across replicas. It reuses an existing bound integration, otherwise the seller's sole active EasyPost connection, otherwise an explicitly configured server credential reference. It never silently chooses between multiple seller connections or rebinds an existing transaction connection.

Provider calls run outside database transactions and outside recording. Temporary failures back off, with eight attempts before attention is required. Missing credentials/connections wait and retry hourly without exhausting that budget. Successful nonterminal trackers refresh every six hours; existing authenticated EasyPost webhooks provide intervening updates. The normal **Update tracking** action can retry a failed lookup once an integration is bound.

EasyPost's Tracker API supports labels purchased elsewhere, carrier detection when no carrier is supplied, tracking history and later webhook updates. Returned tracking identity and production/test mode are checked before import. Status, scan time/location, available estimated delivery and carrier-reported weight use the existing append-only `shipment_events` and shipment integrity supplement. Carrier observations arriving later do not modify the frozen core manifest. Tracker registration alone does not prove carrier possession or delivery.

References: [EasyPost Tracker API](https://docs.easypost.com/docs/trackers), [USPS concatenated routing barcode standards](https://pe.usps.com/text/dmm300/204.htm).

## Activation

1. Deploy the backend/migration and web changes using the repository's reviewed staging deployment path.
2. Provision the EasyPost credential material in the existing server credential store. For an existing deployment, prefer its Secrets Manager reference. For a local environment the existing `env:` store accepts JSON containing `apiKey`, `mode` (`test` or `production`), and `webhookSecret`. No key belongs in the mobile bundle, source, or a client request.
3. Set `PACKPROOF_CAPTURE_EASYPOST_CREDENTIAL_REFERENCE` to that server-side reference (for example `packproof/staging/integrations/easypost`). This is optional when the seller already has exactly one active EasyPost connection. `PACKPROOF_CAPTURE_SHIPMENT_WORKER=false` disables the new background worker.
4. Configure and verify EasyPost's signed webhook at `/integrations/webhooks/easypost-tracker`, following [the existing integration runbook](EASYPOST_TRACKING_INTEGRATION.md).
5. Build the full app with `eas build --platform android --profile shipping-integration`. This opt-in profile inherits the normal Play package, Cognito/API configuration, remote signing credentials, and **AAB** format. Increment the Android version code before a new Play upload if code 29 is already used. The normal `internal-staging` profile keeps the feature off. Never enable the standalone camera-spike flag for either Play profile.
6. Run a real-label smoke test with the configured EasyPost account, then complete the S24/A16 extended matrix before wider rollout. EasyPost test responses must remain visibly marked as test data.

## Validation / remaining external gates

- Targeted backend + mobile queue regression: 28 passed, one existing credential-gated live EasyPost test skipped.
- Additional transaction/Proof contract and packing submission regressions: 19 passed. Queue storage/auth-renewal regression: passed.
- Native HTTP contract test includes the new shipping endpoint, original capture upload/retry, replay, and case export: passed.
- Backend and mobile TypeScript: passed.
- Web production build and normal Android Metro export with the shipping flag enabled: passed.
- The integration has not been exercised against a live EasyPost account. This workspace has no configured EasyPost credential, AWS runtime credential, or Expo automation token. Deployment, actual provider smoke testing, and a newly signed full-app AAB remain external configuration gates. The previously tested APK is the standalone camera diagnostic, not this integration build.

Crash recovery guarantees apply to a saved capture and its persisted journal. A process killed before MP4 finalization may leave an incomplete recording; this feature does not claim continuous capture through process death. Full label images, addresses, provider keys and raw provider response bodies are not stored in the scan observation or application logs.
