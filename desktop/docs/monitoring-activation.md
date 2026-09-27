# Activate desktop reporting

Development and staging builds can run without reporting; production packaging requires a valid PackProof-owned Sentry destination, and publication requires verified delivery. Existing AWS API logs, service metrics, and deployment rollback alarms do not observe local camera, capture, renderer, or updater failures. Do not substitute infrastructure health for desktop reporting delivery.

## Current verified boundary

The reporter accepts only fixed categories and codes. It uses a private current scope, filters the event after SDK processing, and reconstructs the complete transport envelope. Attachments, sessions, internal SDK errors, inherited context, server names, request data, and trace headers are excluded. Tests exercise the actual Sentry serializer with fabricated contaminated global/current/isolation scopes. The event envelope contains only a random event ID, generated send timestamp, fixed code, release version, channel, and OS family. The HTTPS destination still receives ordinary connection metadata, including source IP; verify provider-side IP handling separately.

`SYSTEM/REPORTING_CANARY` is reserved for operator verification. It does not trigger a customer failure or access customer evidence. Development builds never send reports.

## Destination and access

1. An authorized operator must select or create a PackProof-owned Sentry project and confirm its organization, numeric project ID, ingest host, region, retention, project members, and notification destination. Configure provider-side data scrubbing and IP storage controls consistently with the published privacy disclosure.
2. Set its public DSN as `PACKPROOF_SENTRY_DSN` in the protected release environment. A DSN is an ingest identifier, not a management credential. Do not put a Sentry management token in installers, source, receipts, or chat. If API readback is used, obtain its credential from the approved secret manager directly into the operator process.
3. Configure Sentry issue alert routing for the approved operational recipients. Confirm delivery with an authorized operator. Do not claim paging is active merely because a rule or destination exists.

No owned project, DSN, management access, alert delivery, or provider event readback is established by the local tests. The metadata assessment on 2026-09-27 found no Sentry configuration in the inspected staging service or PackProof/Sentry-named Secrets Manager metadata in us-east-1. Repository release-environment variables and external Sentry organizations were not readable through that assessment.

## Send a single canary

Use a clean, committed checkout with `npm ci` completed in `desktop`. Run this only after the destination above is approved. Supply the DSN directly through the process environment using the approved configuration mechanism; do not echo it or put it on the command line.

```sh
cd desktop
APP_ENV=staging node scripts/reporting-canary.mjs \
  --send \
  --approved-project-id APPROVED_NUMERIC_PROJECT_ID \
  --approved-ingest-host APPROVED_HOST.ingest.us.sentry.io \
  --source-commit "$(git rev-parse HEAD)" \
  --output /secure/operator-receipts/reporting-canary.json
```

`PACKPROOF_SENTRY_DSN` must already be set. Production checks use `APP_ENV=production` and the approved production destination. Preserve the execution environment's normal proxy and certificate configuration; do not replace it with only the application variables. The CLI refuses missing explicit send approval, mismatched project/host, invalid hosted HTTPS DSNs, development channels, a mismatched source commit, modified reporter source, and an existing output file. It sends exactly one fixed canary through the same reporter used by the app. It does not accept arbitrary messages, attachments, or account/evidence identifiers. The operator CLI allows a fixed 10-second wait for SDK completion and writes a bounded result before exiting. The desktop application's shutdown budget remains 1.5 seconds; its lifecycle and reporting payload are unchanged.

The receipt includes the exact checked-out source, application version, destination metadata without the DSN key, random event ID, numeric HTTP status, and SDK flush result. `INGEST_ACKNOWLEDGED_READBACK_REQUIRED` means one filtered event received a 2xx response and the queue drained. A transport acknowledgment or flush alone does **not** prove project ingestion, routing, retention, or alert delivery. Every canary receipt has `deliveryVerified: false`.

The receipt also records `waitBudgetMs` and `waitBudgetExceeded`. `INGEST_WAIT_BUDGET_EXCEEDED` means the operator's 10-second deadline elapsed before SDK completion; it does not diagnose network-policy denial or prove the event never arrived. The deadline does not retract an in-flight request. Check the exact event ID in the project before authorizing another attempt. Other unsuccessful outcomes remain `INGEST_NOT_CONFIRMED`, with raw transport errors excluded. This source-level canary does not establish signed Windows/macOS package configuration or production release acceptance.

## Independent project readback

An authorized operator must locate the receipt's exact event ID in the approved Sentry project. Confirm the fixed `SYSTEM/REPORTING_CANARY` code, release, environment, OS family, destination project, and complete payload. Inspect the event's request, user, context, exception, attachment, session, and breadcrumb sections; none should contain customer data or inherited client context. Record the project/event link, readback time, accountable reviewer, observed fields, and alert receipt separately. Never export raw customer events to prove the canary.

Only after that independent check may the exact-source production acceptance entry `centralized-error-reporting-delivery` pass. Preserve the original canary receipt; do not change its `deliveryVerified` field to imply the CLI performed readback. If ingestion or readback fails, leave acceptance incomplete and verify destination/configuration before retrying.
