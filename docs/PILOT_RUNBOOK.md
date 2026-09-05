# PackProof V2 pilot and release gates

The September 4, 2026 comprehensive plan is implemented as an additive platform release. A code merge is not evidence that a camera/device test, live carrier event, or merchant pilot succeeded. Record actual observations below before widening access.

## Initial cohort

Recruit 5–10 consenting sellers handling collectibles, watches, jewelry, electronics, comics or rare sneakers. Prefer sellers already documenting high-value shipments. Use a named seller and receiver pair for the first complete transaction; then expand to approximately 30 real shipments. Do not describe this target as completed recruitment. No seller messages or invitations have been sent by this development work.

Explain the product with **Order → Record → Seal → Proof**. Ask sellers to show the item and identifiers, packing, and completed seal. The first session should lead directly to one real Proof; no onboarding slideshow or extra evidence tiers are required. Clearly explain who will view each recording and how long it will be preserved.

## Technical release gates

| Gate | Required evidence | Stop condition |
|---|---|---|
| Build and migrations | Backend/web builds, mobile typecheck, clean schema migration and upgrade against a staging PostgreSQL snapshot | Migration failure, altered historical core hashes, mixed API/web commit |
| Android release | Signed AAB versionCode 28; install through internal testing; verify native share handler and expo-video playback | Stale app version, startup crash, missing share target, recording cannot replay |
| Two-device golden path | Seller creates/imports order, records/reviews/retakes, commits and attests; receiver accepts; both see same finalized hash | Different root hashes or unauthorized actor actions |
| Interrupted capture/upload | Airplane mode, Wi-Fi/cellular switch, restart app/browser, lost commit response, low storage, expired session, abandoned upload | Lost recording, duplicate committed media, pending upload prevents finalization with no recovery |
| Media quality and speed | Test a representative low/mid/high Android device, portrait/landscape, microphone, autofocus/serial visibility and a 2–3 minute clip | Unreadable identifiers, silent/black media, unacceptable camera launch or memory use |
| Share and privacy | Cold/warm Android text share, malformed text, SUMMARY vs EVIDENCE_VIEW, expired/revoked links, receiver mismatch | Scope bypass, source interpreted as authority, unintended media access |
| API and webhooks | Separate sandbox/live tenants, rotate keys, real approved HTTPS receiver, receiver down/recovered, duplicate/out-of-order delivery | Cross-tenant disclosure, unsigned event accepted, lost durable delivery |
| Carrier/marketplace | Official configured test accounts; import and retry, acceptance/delivery chronology, disconnected provider | Duplicate order binding, guessed carrier observations, claimed live result without provider evidence |
| Portable record | Export root plus receipt/return stages, independently verify with separately obtained root hash, alter one file and confirm rejection | False verification success, missing evidence, stale supplement linkage |
| Capacity | Concurrent 200 MiB core uploads/exports under intended pilot load; memory/RSS and p95 latencies; real PostgreSQL worker leases | OOM, repeated lease expiry, saturation, evidence truncation |
| Storage/retention | Private encrypted versioned bucket; configured Object Lock floor; backup restoration; active hold blocks review; known deletion operator | Early expiry, unreviewed destruction, untested restore |

The local automated suite uses PGlite and controlled transports. It cannot establish PostgreSQL production concurrency behavior, physical camera quality, actual background OS behavior, or signed AAB installation. Native prebuild verifies generated configuration, not those device outcomes. Browser visual inspection also needs a reachable preview; the development environment's cloud browser could not reach its loopback server.

## Live configuration checklist

1. Preserve existing Cognito, S3, PostgreSQL, eBay/Shopify and tracker configuration. Never paste secret values into issues, PRs or logs. Verify `/meta` reports the exact candidate commit and that the matching web bundle is deployed.
2. Inject a 32-byte base64 webhook encryption key from Secrets Manager. The execution role needs `secretsmanager:GetSecretValue` for that specific secret and KMS decrypt permission if a customer-managed key protects it. Permit only the partner's intended HTTPS hostname. Verify real signed delivery before claiming webhooks are live.
3. The API service is sized at 1 GiB for bounded pilot media processing. Measure actual usage. Increase capacity or replace buffering with streamed object-store assembly before supporting concurrent large workloads at scale.
4. Configure an authenticated email-ingress adapter and sender/source validation before advertising a forwarding address. The normalization endpoint already accepts `source: "email"`; a mailbox, DNS/MX and provider webhook verification have not been provisioned here. Do not use a catch-all mailbox or request broad mailbox access as a shortcut.
5. Run the existing optional Cognito, S3 and EasyPost tests only with the intended environment credentials. Provider approval, signing credentials, actual devices and consenting pilot users must be supplied/available; synthetic fixtures do not substitute for these gates.

## Pilot scorecard

These are proposed pilot thresholds, not measured results. Capture start/end times with the seller's consent; never log raw order text, tokens or video contents as telemetry.

| Metric | Definition | Initial decision threshold |
|---|---|---|
| Order preparation | Time from create/import entry to confirmed transaction | Median ≤30 seconds; p90 ≤60 seconds |
| Camera launch | Record tap to usable camera on each device class | p90 ≤2 seconds |
| Seller completion | Eligible started sessions resulting in preserved capture and finalized Proof | ≥90% |
| Recovery | Interrupted uploads completed without retaking a valid recording | 100% of controlled interruption scenarios |
| Evidence readability | Seller/receiver can identify item, package and seal from playback | ≥95% of reviewed pilot Proofs |
| Claims comprehension | Reviewer identifies who recorded what and packing/carrier event order | Median ≤30 seconds |
| Integrity and access | Root digest agreement, package verification, denied unauthorized access | 100%; any failure stops expansion |
| Voluntary repeat use | Sellers recording another eligible shipment without assistance | ≥70% after the first week |
| External adapter independence | Provider disconnect/retry does not corrupt or duplicate core Proofs | 100% of controlled scenarios |

Record one row per test/shipment: anonymized pilot ID, app/API commit, device/OS, intake source, duration, interruption scenario, final Proof ID, root digest comparison, reviewer outcome, and issue link. Keep identifying account data and real recordings in PackProof's access-controlled records.

## Retention and deletion review

The application protects records for at least 90 days after the latest finalized commerce stage. An active hold or unfinished receipt/return blocks deletion review. Only the hold issuer can release their hold. A deletion request creates a durable review item and audit event; it does not physically delete evidence or claim a completed privacy request.

An authorized operator must assess actor authority, retention windows, all holds, claims, Object Lock deadlines, backups and downstream exports before proposing deletion. Record the exact objects/versions affected and the decision. Implement and approve an audited physical-deletion mechanism as a separate policy change; do not disable database immutability triggers to manufacture deletion support. Document outcomes and notify the requester through the approved support process.

## Rollout and rollback

1. Land the candidate only after CI passes. Deploy to staging and run the gates above.
2. Enable one partner's webhook destination and one merchant tenant; compare both interfaces against the same Proof.
3. Invite the consenting cohort and monitor failed uploads, worker failures, dead delivery counts and support issues daily during the pilot.
4. Stop expansion for integrity, authorization or recording-loss failures. Disable outbound webhook dispatch if necessary while preserving queued work. Roll back application images while retaining additive tables and all evidence. Do not delete manifests or reset migrations.

Deferred by the source plan: broad marketplace/carrier coverage, AI adjudication, enterprise dashboards, claims-management software, signed manifests/trusted timestamp authorities, and formal enterprise compliance programs. They are not conditions for falsifying or bypassing the golden-path gates.
