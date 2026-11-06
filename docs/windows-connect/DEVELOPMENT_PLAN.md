# PackProof Connect — Windows Setup and Integration Assistant
Status: architecture and implementation RFC; no installer or runtime activation is claimed.
Date: 2026-11-06
Target repository: thepackproof/packproof-v2
Proposed name: PackProof Connect
Initial supported OS: Windows 11 x64. Windows 10 only for explicitly tested supported enterprise configurations.

## Decision

Build a separate, signed PackProof Connect Windows product to configure **optional local source connectors** for PackProof's existing hosted API. Do not install or expose the canonical backend, a database, the signing service, or the entire Proof engine on customer PCs. Offer a cloud-only setup path when the selected provider supports secure hosted authorization. Keep PackProof Desktop's capture workstation independently installable and releasable.

The current repo already has an Electron/NSIS Windows packaging, Authenticode, update, signing and acceptance pipeline under desktop/. Reuse vetted patterns and shared brand components without reusing Desktop's product identity, update channel, account evidence directories, or packaging artifact names. A new Connect release must not overwrite the capture workstation.

## Evidence-based baseline / constraints

- docs/api-portal-v1/CONTINUATION_2026-11-04.md records that full records/portal work is not general available and that a provider-specific automatic connector has not been qualified.
- backend/src/records/connections.ts currently presents spreadsheet as one-time import, assisted connections as requested, and the automatic-sync flag as false. A missing checker deliberately reports CONNECTION_ADAPTER_NOT_CONFIGURED.
- backend/src/records/connections-router.ts accepts administrative test, reconcile, pause and resume commands only within authorized organizations.
- docs/api-portal-v1/QUICKSTART.md and SDK.md require scoped service principals, immutable source identities, stable idempotency keys, authorization, tenant segregation, and durable receipt handling.
- desktop/README.md and electron-builder.config.cjs already implement per-environment application identities and an NSIS executable for the fulfillment workstation, not an on-premise integration agent.
- The source may be ahead of the deployed backend and website. Never treat a passing compile as a production release or claim that customer sources are connected.

## Product promise

A non-technical warehouse administrator should be able to:
1. Download one signed PackProof Connect Setup.exe from an authenticated source.
2. Open it, sign in to PackProof using a protected browser/device flow, select the correct organization, environment and location, and understand permissions.
3. Choose a **supported connector** or the explicit assisted-setup option, with an accurate explanation of what PackProof can and cannot detect.
4. Select the minimum authorized data access and preview exactly what will leave the premises.
5. Verify identifier mapping, timezone, shipment units, package dimensions, evidence/source provenance, cadence and duplicate rules.
6. Run a read-only discovery and dry run, followed by an explicitly authorized test with a real durable PackProof receipt.
7. Activate background sync and see a source watermark, last processed item, real health status, and next action.
8. Pause, recover, update or remove the agent without deleting an unacknowledged queue or revoking unrelated integrations.

A user must never have to paste API keys, edit environment files, open inbound firewall ports, run PowerShell commands, or understand HTTP/webhook jargon in the normal happy path.

## Two product paths

### A. Cloud connection (preferred where supported)
- Browser authorization and managed credentials; no Windows installer.
- Remote connector receives a named provider capability declaration and validation.
- User can open the same guided flow in /app/records/connect.
- Show this path first when on-prem access is not required.

### B. Local Windows connection (this deliverable)
- Signed NSIS Setup.exe with dedicated application identity and update channel.
- A polished interactive setup UI (separate process, no privileged code in the renderer).
- A small managed agent/service with outbound HTTPS only, durable local queue, bounded spool and source adapters.
- Install **per-machine as a Windows service only** when unattended operation is needed; request Windows administrator elevation at that specific step with a plain-English explanation. A limited pilot can run per-user without permanent service installation, visibly labeled as sign-in dependent.
- No silently installed system driver, firewall exception, scheduled task or browser extension.
- Source files and media are read only from folders/tables chosen by an authorized customer operator.

## Experience map

Screen 1 — Welcome
- Value statement: Connect the tools you already use; no code required.
- Brief privacy/permissions explanation and link to human support.
- 'Connect a local system' / 'Connect a cloud service' (capability dependent).
- Trustworthy publisher/environment information and update state.

Screen 2 — Automatic preflight
- Confirm Windows and architecture, disk availability, local time and clock skew, TLS trust, internet reachability, enterprise proxy path, required firewall egress, and Windows privileges.
- Show pass, needs action, not checked, and not applicable as distinct states.
- Do not tell customers to disable security software.
- Diagnostics disclose exact categories before export; never reveal secrets or customer rows.

Screen 3 — Sign in and choose workspace
- Authenticate in the default trusted system browser with OAuth/OIDC authorization code + PKCE, or a server-backed device authorization flow. No embedded password capture and no service tokens in a renderer.
- Recent-auth administrator approval is required for device enrollment.
- Display organization, selected environment, location authorization and current entitlement. Explicitly stop when production activation is not approved.
- One workstation enrolls to one organization/environment at a time; multi-tenant use requires explicit isolated profiles and scoped credentials.

Screen 4 — Discover and select source
- Offer an explicit supported provider catalog and its exact minimum system version.
- Discover only with consent: installed product metadata, opted-in folder paths and ODBC DSN **names** (not connection strings, credentials, or contents). No blanket network scans or filesystem crawling.
- Provider not supported: explain the assisted integration process and permit the documented one-time CSV import as a distinct fallback. Never label a spreadsheet as live sync.
- One source/location, connection ownership, and expected sync cadence are selected at a time.

Screen 5 — Authorize and map
- Show authorization method, exact read/write abilities and files/fields crossing the boundary.
- Read-only access by default. Secrets live in Windows protected storage under the service identity or a protected customer-managed secret store; never renderer/localStorage/logs.
- Suggest likely mappings using safe header patterns, but confirm source reference, original IDs (including leading zeros), timestamps and timezones, quantities, units, item identity, and expected event type.
- Uncertain or ambiguous mappings remain blocked, not silently guessed.
- Present a source-origin/assurance label; a source claim does not become independently verified physical evidence.

Screen 6 — Preview and validate
- Run source connectivity with a narrow, read-only query or permitted file sample.
- Present source counts, sample rows and resulting PackProof record preview. Mask sensitive fields by default.
- Clearly distinguish a successful credential check, sample read, mapping validation, API admission, durable ingest completion and visible record.
- In production, require explicit consent for the first actual record submission; offer sandbox with synthetic fixtures where available.
- Verify result by polling the existing durable ingestion operation and fetching the created authorized Proof, not just checking that a POST returned 202.
- Same source event ID and idempotency key survive lost response/retry.

Screen 7 — Activate and finish
- Activate only after successful end-to-end checks and appropriate administrator authority.
- Show actual connection status, last source watermark, oldest pending record, next expected sync, queue count, service health, last PackProof receipt and a 'View record' deep link.
- Provide Pause, Re-test, Export redacted diagnostics, Contact support, and Open records dashboard actions.
- For an unsupported pilot, finish in 'Needs assisted setup' rather than a fake green success.

## Technical architecture

Proposed directories (not yet implemented):
- connect-windows/ui/ — setup UI, shared design tokens and accessible screens.
- connect-windows/main/ — desktop bridge and browser enrollment orchestration.
- connect-windows/agent/ — small isolated Windows Service and local queue.
- connect-windows/adapters/ — independently versioned, capability-declared source adapters; no arbitrary dynamic code execution from an external catalog.
- connect-windows/installer/ — signed NSIS setup, per-product identity, install/repair/uninstall.
- connect-windows/tests/ — privilege, idempotency, offline recovery, upgrade/uninstall, accessibility, and E2E harnesses.
- backend/src/records/agent-enrollment* — dedicated short-lived enrollment and device management paths behind existing organization grants.
- docs/windows-connect/ — product, support, capability, privacy, and release evidence.

The agent should be independent from the Electron UI process. Window close/sign-out must not stop an explicitly enabled Windows service, and agent health must not depend on the presence of an interactive desktop session. The UI holds no unrestricted service credential; machine/service authorization binds to one merchant, environment, installation identity, source and granted actions. Service and UI must authenticate to each other with OS IPC and explicit ACLs. The core API stays hosted, server-authoritative.

### Enrollment protocol

1. Human signs in through OS browser and selects an active authorized workspace.
2. Server creates a short-lived, single-use enrollment intent with organization, environment, source, approving user and expiry. Require recent authentication for grant creation.
3. Agent generates an installation-bound asymmetric key pair using OS protected key storage; sends public key and challenge proof. No private key travels to the server.
4. Server confirms fresh admin consent, exact grant scope, challenge, non-reuse and organization status, then issues a narrowly scoped, revocable installation credential via an encrypted authenticated channel.
5. Agent stores its credential outside the renderer, scoped to the service identity. Rotate and revoke independently. Expired/revoked grant stops new reads and uploads; already durably accepted receipts remain available.
6. Portal records the enrollment audit, device name, version, source, last seen, scope, expiration and revoke control. Never surface full secrets again.

Do not reuse a generic developer token, claim an existing device-pairing endpoint, or embed a partner key in a packaged binary. Exact API routes and schema must be versioned only after the server grants/credential model is reviewed.

### Source ingestion and provenance

- Use the current packproof.partner/v1 ingestion contract and documented SDK semantics for authorized source events; preserve raw source and source-native identifiers within supported retention policy.
- Every item uses (organization, environment, integrationAccountId, sourceEventId) and stable idempotency key; replay preserves exact semantic payload. Conflict becomes a clear review task.
- Send only bounded batches within API admission limits, obey Retry-After and backoff, use a persistent checksumed append-only queue and an acknowledged cursor. Never drop accepted-but-unconfirmed work on restart or uninstall.
- Distinguish source reported time, receipt time and PackProof processing time. Record original provenance and source assurance accurately.
- Do not use an agent/service credential to impersonate a human or perform personal attestations, finalize protected capture, or bypass document/evidence signing.
- Start with **one authorized pilot source**, selected with a real customer. The candidate can offer a consented folder-based CSV export watcher if that is the real provider's supported handoff, but it is a *separately qualified continuous connector*, not the current one-time CSV import.
- Build read-only SQL Server/ODBC support only for a versioned, customer-approved schema and least-privilege query contract. Avoid arbitrary SQL supplied by the installer.
- Cameras/recording may reuse PackProof Desktop capture; Connect does not manufacture camera evidence from business records.

### Runtime protections

- Windows service runs least-privileged with dedicated service SID/ACLs, restricted protected app-data paths, named-pipe authorization and network egress. Never run the ordinary agent as LocalSystem unnecessarily.
- Outbound TLS to allowlisted PackProof origins; no listening internet server, no UPnP, no blanket discovery broadcast.
- OS credential encryption appropriate to the service context, protected queue at rest, no passwords/tokens in telemetry, and secure log redaction.
- Hard limits on watched directories, file sizes, CPU, memory, spool budget and retry rates. Handle full disk without deleting originals or acknowledged audit.
- Installer/updater verifies Authenticode publisher, update channel and artifact digest. Sign installer and service executable. Unsigned/dev candidates never auto-promote to production.
- Fail closed on authorization changes, environment mismatch, ambiguous mapping, missing capability or unverified receipt.
- Account for corporate TLS proxy, VPN, intermittent connectivity and machine clock skew with understandable fixes, not security bypass advice.
- Uninstall preserves unacknowledged evidence/queue and offers a documented separate authorized cleanup after synchronization and retention check.

## Delivery slices

P0 — Release design and capability contract:
- Confirm the pilot's actual OS, source software, version, field sample, permissions and continuous data access.
- Approve the separate Connect product/release identity and no-install cloud path.
- Specify server enrollment endpoints/authorization, adapter catalog format, local queue schema, provenance and diagnostics privacy.

P1 — Thin vertical slice:
- Native Windows signed development package, browser-based enrollment, installation identity, single organization/environment and real service registration.
- One narrowly qualified source adapter reads a customer-authorized test fixture.
- Durable agent queue -> partner API ingestion -> canonical Proof -> portal link, with a test receipt.
- Pause/revoke, crash recovery, deduplication, source expiry and offline retry automated tests.

P2 — Guided first-run user experience:
- Seven-screen wizard, responsive layout, high contrast, reduced motion, keyboard/screen reader, progress/resume.
- Real preflight checks, context-aware explanations, readable mapping preview and redacted support exports.
- Failure-specific recovery, real statuses and documented support handoff.

P3 — Enterprise lifecycle:
- Signed automatic agent updates with safe rollback, service restart/repair, tenant environment separation and monitored fleet.
- IT admin deployment option (silent install with preapproved non-secret configuration), endpoint management compatibility and per-site rollout.
- Realistic agent resource caps and local queue retention/recovery.

P4 — Qualification and customer release:
- Windows 11 real PC; enterprise proxy/blocked internet; non-admin enrollment; admin elevation; restart/logout; offline 24h; power loss; full disk; token expiry/revocation; outdated adapter; source mutation; migration/rollback; signing/provenance.
- Run at least five novice first-time sessions with no technical assistance and document outcomes.
- One named pilot source reconciled against complete bounded source input and PackProof receipts in an approved environment.
- Security review and release operator approval. Deployed backend activation/roles must be separately verified.

## Gold-standard acceptance metrics (targets, not observed results)

- At least 90% of novice test participants complete a supported first setup without assistance; 100% know when an unsupported source needs help.
- Median first usable connection <= 10 minutes for a supported source with accessible credentials, 95th percentile <= 20 minutes. Measure from download through a visible acknowledged record.
- 0 manual token copying, terminal commands, inbound firewall rules, or unconsented source discovery on the happy path.
- 100% real end-to-end completions show an authorized source read, durable receipt and visible linked Proof; no false 'Connected' state.
- 100% deterministic deduplication for synthetic retry/restart/reinstall cases and no loss of admitted unacknowledged queued items.
- Updates never silently switch environments, revoke unrelated accounts, or delete queue data. Revoke disables newly issued agent work.
- Accessibility: complete setup by keyboard and screen reader at 200% scale and with reduced-motion preference.
- Installation behavior: user can distinguish service vs UI, choose supported installation scope, repair or uninstall; enterprise software distribution has a separate verified channel.
- Ship only a signed release with reviewed Windows publisher identity, verified update chain, realistic staged rollout and documented rollback.

## Explicit exclusions / release blockers

- No claim that all WMS/ERP programs can be auto-discovered or seamlessly connected.
- No general production connection until a real adapter is qualified and deployed authorization is active.
- No scanning credentials, reading data without customer approval, arbitrary SQL, automatic broad network searches or unapproved outbound data transfers.
- No 'green' success after login-only, test-button-only, or queued-only events.
- No new background automation that modifies source systems without a separate owner-approved write contract.
- No release simply because the NSIS .exe builds; installer trust, end-to-end data correctness, customer acceptance and operational recovery are independent gates.

## Key references

- desktop/README.md; desktop/electron-builder.config.cjs; desktop/docs/RELEASING.md
- docs/api-portal-v1/QUICKSTART.md; SDK.md; CSV_IMPORTS.md; SOURCE_INGESTIONS.md
- backend/src/records/connections.ts; connections-router.ts
- docs/api-portal-v1/IMPLEMENTATION_STATUS.md; CONTINUATION_2026-11-04.md
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
- https://www.electron.build/v26/docs/win/
