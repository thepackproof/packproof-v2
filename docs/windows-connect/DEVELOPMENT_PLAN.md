# PackProof Windows Setup & Integration
## Full development plan and coding-agent execution contract

**Prepared for:** Collin Neri | PackProof  
**Date:** November 6, 2026  
**Working feature name:** PackProof Connect (not a requirement to introduce another public product brand)  
**Document status:** Implementation specification; no executable, deployment, customer connection, or acceptance result is claimed.  
**Scope:** A polished Windows setup experience and a reliable local connection to PackProof's existing hosted API.  
**Priority:** Deliver one trustworthy, easy-to-use integration before expanding connector coverage.

> The customer outcome is not “software installed.” It is “my authorized shipment export becomes a usable PackProof record automatically, and I understand whether the connection is working.”

This document expands the earlier Windows Connect RFC in draft PR 146. Where the two disagree, the explicit scope and sequencing here supersede the earlier proposal for this development assignment. The existing prototype is a visual reference, not production code or a list of implemented connectors. [R1, R7]

---

## 1. Executive decisions

### 1.1 What to build

Build one signed Windows installer that installs a guided setup application and a small unattended service. The service reads one explicitly approved export folder, preserves a bounded local copy, and submits files through the existing PackProof service-import API. The customer signs in through the existing PackProof website, approves the workspace and source, confirms the mapping, sees the first real record, and enables recurring collection.

The first supported connector is **Scheduled CSV Export Folder v1**: immutable UTF-8 CSV files emitted into a local Windows folder by the customer's existing software. This is a product decision for a narrow, reusable first connector, not evidence that Winsupply or any particular WMS supports the required export. Actual customer support is declared only after that source's export contract is validated.

Do not install the canonical API, PostgreSQL, a signing service, Docker, Node development tools, or a development environment on the customer's PC. PackProof remains hosted and authoritative. Prefer a browser-only connection when an already-qualified cloud integration can do the job; do not make this project build new cloud connectors.

### 1.2 Architecture decisions that are closed

| Area | Decision | Reason / boundary |
| --- | --- | --- |
| Setup interface | Existing React/TypeScript and Electron patterns; distinct Connect packaging identity | Reuse PackProof visual components and hardened desktop conventions without overwriting the capture app. |
| Unattended worker | One small C#/.NET 10 Windows Worker Service, self-contained win-x64 publish | Native service lifecycle, Windows permissions, protected storage and named pipes without stacking Node service wrappers and native bridges. No backend rewrite. |
| Installer | Existing electron-builder/NSIS approach; one per-machine package | One installation mode, one upgrade path, one explicit Windows administrator approval. |
| Cloud behavior | Existing organization policy, service credentials, CSV imports, canonical records, workers and portal | Add enrollment and installation restrictions, not another ingestion platform. |
| Local durability | Microsoft.Data.Sqlite for queue metadata; encrypted file spool | Transactional recovery without installing a local database server or inventing a journal engine. |
| Setup intelligence | Deterministic checks and mapping suggestions | No LLM dependency, autonomous SQL, or probabilistic identity matching. |
| First support envelope | Windows 11 x64, local NTFS export folder, one organization/environment/source per installation | Avoid an untested matrix of operating systems, network accounts and providers. |
| Distribution | Signed direct-download installer and verified in-place upgrades | Store, MSI, ARM64 and enterprise packaging extensions are later work. |

The .NET worker is a deliberately narrow new component because no unattended service was established in the reviewed baseline. It is not a port of the API, SDKs, desktop capture application, or web portal. It calls a small fixed HTTP surface and lets the backend perform all business validation. Microsoft documents the Worker Service route and self-contained deployment; .NET 10 is the supported LTS choice checked for this plan. [T1, T2]

**Exception:** If the implementation checkout already contains an accepted, tested Windows service meeting these requirements, reuse it instead. Record that evidence once; do not replace working code merely to match this language choice. Do not run a framework comparison exercise.

### 1.3 What “full” means

The assignment includes source implementation, executable packaging, end-to-end integration, interruption recovery, permissions, upgrades, diagnostics, accessibility, release evidence and customer acceptance. It does not mean implementing every future adapter or fixing every unrelated PackProof issue.

Use four explicit completion states: **implemented**, **verified in test**, **deployed**, and **accepted for the named customer/source**. None implies the next. A source-only result must never be called live.

---

## 2. Source baseline and reuse map

### 2.1 Evidence used

The reviewed RFC is commit `29ab13fe2d654eb04babe9e1dc89e6844a2c51ce` on `feature/packproof-connect-windows-setup-rfc`. Its draft PR 146 was open and unmerged when checked. The source baseline referenced by the PR is `a42c10653258b63217043f8670b94ca87a233684`. Refresh the actual implementation branch once at the start because other work may have landed. [R1]

The prior desktop source includes an Electron application and NSIS packaging, separate environment identities, credential storage, diagnostics and release/signing checks. That establishes reusable patterns, not a completed local synchronization service. The records source includes service-authenticated CSV imports and read-only connection inventory; source availability is not proof of deployment. [R2–R5]

### 2.2 Reuse before adding

| Existing area | Reuse | Do not do |
| --- | --- | --- |
| `desktop/` build and release scripts | Security flags, publisher checks, artifact naming conventions, native CI patterns | Copy the entire capture application or change its product ID, evidence directory, release channel or privileges. |
| `web/src/records/` | Existing workspace, record link, source-health and administrator presentation | Build a second logistics dashboard inside the installer. |
| `backend/src/platform/` | Organization membership, entitlement, principal issuance, revocation, idempotency and audit | Create independent user accounts, tenants, roles or unrestricted installer API keys. |
| `backend/src/records/partner-imports.ts` and related routers | CSV preview, explicit commit, durable row outcomes and permanent source bindings | Create another CSV business validator, Proof factory, import worker or deduplication database. |
| `backend/src/records/connections.ts` | Existing connection state and administrative controls | Mark existing one-time CSV imports as continuously synchronized. |
| Existing source storage | Immutable original, server-computed digest, storage version and receipt | Treat an agent checksum as server verification or sign shipment truth locally. |
| Existing partner contract | Documented request/response semantics and fixtures | Generate or port a complete .NET SDK just to call a handful of operations. |

Service CSV already exposes preview, commit and status routes. Reviewed limits are 2 MiB, 1,000 data rows, 50 columns and 10,000 characters per cell, with an explicit time zone. Its original bytes and row results are retained through the existing backend. These constraints are a ready-made first-connector boundary. [R3]

### 2.3 Live-readiness boundary

The November continuation records outstanding deployment and source-qualification work. This plan does not assert those historical blockers remain unchanged today. W01 must check the intended environment's current capability and release receipts once. A disabled organization feature or missing migration becomes a named dependency, not a reason to rewrite the API or repeatedly attempt production activation. [R6]

---

## 3. Scope, support and intentional exclusions

### 3.1 Required for the first customer release

The release includes a signed `.exe`, seven-step setup, browser approval, least-privileged background service, one local export-folder connector, mapping preview, explicit upload consent, first-record verification, persistent queue, server-backed status, pause/resume/revoke, bounded retry, upgrade/repair/uninstall, credential renewal, redacted diagnostics and the existing portal's connection entry.

“Usable by anybody” means an authorized nontechnical operator can complete the supported path without coding. It does not remove the customer’s Windows administrator, source-access or data-consent requirements.

A customer PC need not run the source application itself. It must have approved access to the export location and remain on when collection is expected. Install **once per source connection on the chosen collection PC**, not on every office computer. The portal and other PackProof applications remain available from other devices.

### 3.2 Support matrix

| Dimension | Release-one support | Later, only when required |
| --- | --- | --- |
| Operating system | Supported Windows 11 x64 build, tested exact versions recorded | Windows Server, Windows 10 exceptions, ARM64, macOS and Linux |
| File location | One dedicated local NTFS folder; nonrecursive | UNC/SMB shares, mapped drives, OneDrive placeholders, recursive trees |
| Export shape | New immutable UTF-8 CSV files; stable shipment reference; one shipment per row | Mutable snapshots, XLSX, XML, JSON, EDI, grouped item tables |
| Integration authority | Direct merchant installation approved by an eligible OWNER/ADMIN | Delegated partner installations and new location-grant models |
| Workflow | Create/read source-linked shipment records using current import behavior | Source-system writeback, silent correction of existing records, automation of human attestation |
| Data | Shipment metadata and exact approved CSV original | Generic photo/video ingestion, cameras, printers, scanners, robotics and IoT drivers |
| Network | Outbound HTTPS; direct access and a tested unauthenticated proxy path | PAC/NTLM/Kerberos proxy support and customer-specific network profiles |

Keep the assisted-setup path visible for unsupported cases. It produces a concrete handoff describing the missing prerequisite; it never displays “Connected.” A source requiring a network share may use an existing customer-managed export/copy to the supported local folder, but this is a customer prerequisite, not a hidden PackProof synchronization feature.

### 3.3 Deferred work is not required for completion

No universal WMS discovery, SQL/ODBC connector, desktop scraping, screen-reading automation, connector marketplace, arbitrary plugin loading, custom certificate authority, TPM attestation, distributed leader election, Kubernetes, new message broker, fleet-management console, billing redesign or mobile redesign belongs in this release.

Do not implement SQL because the prototype contains a SQL card. That card is a future concept. Hide it from available choices or label it clearly as assisted/not supported. [R7]

---

## 4. Anti-overengineering review: changes to the original proposal

This review identifies concrete places where a coding agent could do substantial work without improving the first customer outcome.

| Trap | Why it expands work | Binding correction |
| --- | --- | --- |
| “Discover compatible systems” | Encourages registry crawling, network scans and provider heuristics | Discover only the selected folder and explicitly supported capabilities. No application inventory scanner in v1. |
| “Install the API” | Suggests local infrastructure and database deployment | Install a client/service only. The API stays hosted. |
| “One real pilot before starting” | Can block all development on customer access | Use synthetic fixtures for engineering; require actual customer exports only for customer qualification. |
| New cryptographic installation key infrastructure | Creates enrollment, certificate rotation and attestation work | Reuse scoped service credentials and protected storage. Hardware-bound identity is a later risk-driven project. |
| Electron used as a Windows service | Adds wrappers, user-session assumptions and native-module work | Keep Electron interactive; use one native Worker Service. |
| Porting PackProof to .NET | Converts a small Windows component into a platform rewrite | Implement only folder collection, queue, native integration and a thin HTTP client. |
| New ingestion/normalization engine | Duplicates tested server rules | Existing preview/commit/status imports remain authoritative. |
| Per-user plus per-machine installation | Doubles lifecycle, permission and update testing | One per-machine installer; non-admin users get an IT handoff. |
| A custom auto-updater | Creates a privileged remote execution surface | Reuse signed NSIS distribution/update mechanics with fixed lifecycle hooks. No arbitrary updater commands. |
| “Intelligent” means an AI model | Adds costs, nondeterminism and privacy review | Header suggestions, validations and explanations are deterministic. |
| “100% of tests must pass” across unrelated products | Triggers Android/iOS rebuilds and unrelated repairs | Run change-relevant checks during iteration; honor required CI at merge without unscoped repairs. |
| Five testers used to claim a 90% success rate or p95 | Creates misleading acceptance statistics | Report actual counts for small studies; performance percentiles require an adequate measured sample. |
| “Verify one row” against a batch-only commit API | Tempts an agent to invent selection endpoints or silently import more data | Use a one-row export or obtain explicit whole-batch approval; retain the existing commit contract. |
| Prototype success flags copied into production | Produces attractive but false completion | Replace each simulated step with a real state/receipt; add stale-state invalidation tests. |
| A source heartbeat called “data current” | Hides a stopped ERP export job | Separate service online, folder checked, last export and last completed import. |
| Endless blockers and repeated retries | Consumes the run without progress | Two evidence-driven retries per unchanged external blocker, then record it and continue independent work. |

**Non-negotiable distinction:** Reducing work does not justify removing tenant checks, durable recovery, signature verification, permission enforcement, integrity checks or genuine acceptance tests. Cut breadth and duplicated mechanisms, not safety.

---

## 5. Product architecture and repository boundaries

### 5.1 Runtime responsibilities

**Setup UI:** Displays local status, asks for consent, opens the trusted browser, collects folder selection and mapping choices, and shows server receipts. It has no service bearer token and cannot submit arbitrary SQL, shell commands, URLs or filesystem instructions.

**Windows service:** Owns source reads, the encrypted spool, durable queue, protected credentials, API requests, retry scheduling and heartbeat. It continues after the UI closes or the Windows user signs out. It does not create its own concept of a finalized Proof.

**Existing backend:** Owns membership, installation restrictions, canonical source identity, original storage, parsing, Proof creation, deduplication, audit and durable import outcomes.

**Existing records portal:** Owns browser approval, workspace administration, record inspection, connection health and revocation. The Windows app links to it rather than reproducing it.

The flow is: approved export folder → Windows service → existing partner import endpoints → canonical PackProof record → existing portal. The UI controls setup; it is not in the data path after activation.

### 5.2 Proposed code locations

| Path | Responsibility |
| --- | --- |
| `connect-windows/ui/` | Local React screens, styles, state transitions and accessibility |
| `connect-windows/main/` | Electron main/preload, narrow named-pipe bridge and trusted external navigation |
| `connect-windows/service/` | One .NET Worker project: collection, queue, DPAPI, pipe server and fixed HTTP transport |
| `connect-windows/installer/` | NSIS hooks, service registration, ACLs, repair and upgrade behavior |
| `connect-windows/tests/` | UI, Windows acceptance and synthetic export fixtures |
| `backend/src/records/agent-*.ts` | Minimal installation/enrollment restrictions and heartbeat integration |
| `web/src/records/` | Browser approval page and small connection-detail additions |
| `docs/windows-connect/` | This plan, one implementation status file and one operator runbook |

Names are proposed, not claims that those files exist. W01 may map them to existing equivalent files. Extract shared code only when both applications immediately use it. A few small packaging/configuration repetitions are preferable to a monorepo rebuild or a generalized component framework.

### 5.3 Dependency rules

Reuse the repository's supported React/Electron/build versions unless a documented compatibility or security issue requires a change. Pin the .NET SDK and packages in the new project. Use Microsoft's Windows hosting, SQLite and protected-data facilities; select at most one maintained CSV parsing library for local structural preview if necessary. Do not implement a CSV parser, encryption primitive, database engine or service wrapper from scratch.

The local CSV reader is only for headers, sample rows and structural warnings. Server preview remains the sole business normalization/acceptance decision. Contract fixtures cover both sides. No general-purpose C# partner SDK is required.

---

## 6. Installation topology, permissions and local storage

### 6.1 One collection host per source

Choose an always-on, customer-approved PC with a stable export folder. During setup ask “Will this computer stay on when shipment exports are created?” Explain that sleeping/shutdown stops collection; do not change power settings automatically. A second installation selecting the same active source must identify the existing installation and require an explicit replacement workflow.

Use server-side permanent source references to prevent duplicate records even if two hosts overlap during replacement. Do not build a cluster or high-availability election protocol. Revoke/pause the old installation before authorizing its replacement whenever possible.

### 6.2 Windows identities

Install under Program Files. Store machine data under a dedicated ProgramData directory, separated by environment. Run the service as LocalService with its service SID enabled and explicitly applied file permissions, not LocalSystem. Grant read/list access only to the selected export folder; give write access only to PackProof's own queue/log directories. The installer may prepare a dedicated default export folder with explicit producer-user write and service read permissions. Another folder must already permit service access or require a clearly identified IT permission change; do not recursively rewrite its ACLs. The one-elevation happy path assumes the prepared folder or preapproved permissions.

LocalService has minimal local privileges and anonymous network credentials. A folder visible to the installer user is therefore not proof that the service can read it. Test access from the actual running service identity before activation. Network-share support is intentionally excluded from the first release. [T3]

Use a narrowly scoped local operators group or exact approved Windows SIDs for UI-to-service access. Ordinary machine users must not inherit access to shipment previews, credentials or control commands. Sensitive configuration still requires current PackProof administrator approval; local group membership alone does not confer cloud authority.

### 6.3 Secrets, spool and metadata

Keep service tokens encrypted with DPAPI under the service identity. Generate a random spool encryption key, wrap it with the same protected-storage mechanism, and use a standard authenticated encryption library for spool payloads. SQLite contains identifiers, state and encrypted sensitive payloads; no plaintext customer rows or bearer values in its database, WAL, temporary files or logs.

Machine-scope DPAPI by itself is not user isolation: Microsoft documents that other machine users can decrypt machine-scope data when they can access it. Do not silently fall back to machine-wide encryption or plaintext when service-identity protection fails. Fail with a specific protected-storage diagnostic. [T4]

A single service process owns SQLite writes. The UI does not open the database. No remote database listener is created. Machine rebuilds do not imply portable decryption: recovery means re-enrollment and explicit replay from retained source exports, not copying secrets between PCs.

---

## 7. Guided setup and visual specification

### 7.1 Separate installation from onboarding

Keep the signed installer conventional: publisher/product identity, installation location and a clear statement that a background service will be installed. Obtain Windows elevation once. After installation, launch the setup UI as the original non-elevated user; never launch its browser as the administrator who supplied credentials. Test this explicitly with different standard-user and administrator accounts.

The polished seven-step experience belongs in the application, not a custom installer framework. An IT administrator can install the software first; an authorized business user can finish the browser approval later. Lack of elevation is a handoff, not a reason to downgrade silently to an unreliable per-user background task.

### 7.2 Screen requirements

| Screen | User action and content | Evidence required to advance |
| --- | --- | --- |
| 1. Welcome | “Connect your shipment exports.” Explain the service, hosted API, supported source and no-install browser alternative. | User selects the supported local path or leaves for an existing cloud/manual path. |
| 2. Computer check | Check exact Windows/architecture, service presence, disk, TLS, proxy, clock reasonableness and protected storage. | Each check is passed, warning, blocked or not checked; no simulated green states. |
| 3. Workspace | Open the PackProof browser approval page. Show matching installation code; select organization, location and responsible teammate. | Server confirms eligible administrator approval, active entitlement and a setup-only installation binding. |
| 4. Export source | Choose one dedicated folder; explain scheduled CSV prerequisites; show local-only headers/sample. | Actual service identity can read it; source contract is supported; upload consent is explicit. |
| 5. Field mapping | Suggest exact familiar headers; confirm stable reference, description, quantity, time zone and optional fields. | Explicit cloud-preview consent, server preview and browser approval of the exact source/mapping/test policy; invalid/ambiguous rows are explained. |
| 6. Verify the first import | Show the exact batch count and chain: source read, preview, deliberate commit, durable result, open authorized record. | Every expected row has a terminal explained outcome and at least one accepted record is retrieved; 202 alone is insufficient. |
| 7. Turn on automatic collection | State exactly what will be watched and when; show last export/import and pending count. | Current browser approval authorizes recurring collection for the exact verified configuration; service acknowledges activation. |

**Two separate data permissions:** Local preview reads only on the PC. “Create secure preview” uploads the entire selected CSV original to PackProof for server preview and preservation, including columns not mapped to record fields. Explain this before upload. Mapping a subset does not redact the original. Offer cancellation and customer-side re-export with approved columns; do not silently strip source bytes.

The existing commit endpoint commits the previewed batch, not an arbitrarily selected row. Prefer a one-row authorized export for setup verification. For a larger file, show the full record count and obtain approval for the entire batch; do not silently split the original or build a row-selection API.

The first production verification creates real source-linked records and may preserve an original. Name the actual shipment or batch and disclose that it is not disposable test data. Synthetic records belong only in an approved sandbox; do not silently place synthetic records in live data.

### 7.3 State model and invalidation

Persist the last approved step, installation ID, configuration revision and nonsensitive choices. Never persist human passwords or browser tokens. On reopening, reload server authorization and service status before trusting cached progress.

Changing organization/environment invalidates source, mapping, preview and verification. Changing folder, source namespace, operator, location, parser profile, time zone or mapping invalidates the exact preview and verification. A new file requires a new preview. The UI must not allow “Back → change source → Finish” using an earlier successful test.

An approval page can remain open and reuse the existing browser session. Initial enrollment grants setup/preview authority only. Configuration and activation proposals never become active just because the service submitted them; a current authorized administrator confirms them in the browser. The application opens the pending approval directly, with no manual tokens or repeated account creation.

Use explicit states such as `needs_install`, `needs_approval`, `source_selected`, `preview_ready`, `verification_pending`, `ready_to_activate`, `active`, `paused`, `action_needed` and `revoked`. Keep ingestion job states separate. A seven-step UI does not require a state-machine framework; use typed states and a small tested transition function.

### 7.4 Visual and accessibility requirements

Use PackProof's approved document-inspired visual language: white/light surfaces, clear hierarchy, blue actions, green confirmed success, amber attention and red failure with text labels. Reuse the real logo and available brand fonts; do not invent another logo from the prototype's placeholder. Avoid decorative gradients, perpetual motion and fake progress percentages.

One primary action per screen, visible Back, save/resume, a compact progress rail and an inline “What will PackProof access?” explanation. Show technical detail on demand. Use readable field labels rather than endpoint names. Replace generic “Something went wrong” with what happened, what is preserved and the next action.

Support keyboard-only setup, screen-reader announcements, visible focus, non-color status cues, reduced motion, 200% scaling and a 1366×768 reference display. Test larger displays as well. Long filenames and organization names must wrap without displacing actions. Prefer existing component primitives; no animation framework or design-system rebuild.

---

## 8. Browser approval and installation authorization

### 8.1 Enrollment approach

Use a small **portal-mediated installation approval** flow over PackProof's existing human authentication. This is not a new OAuth server or a claim that Cognito supports a particular device grant. The Windows service never collects a user's PackProof password and the UI never receives its service credential.

When the user clicks Connect, the service requests a short-lived enrollment intent. The server returns a high-entropy private polling/redeem secret to the service and a separate human comparison code/approval locator for display. The default browser opens only the allowlisted PackProof approval page. The user signs in through the existing web flow, compares the code, sees the requested organization/source authority and explicitly approves or denies.

Initial approval is setup-only: preview is permitted after explicit data consent, but commit/continuous collection are denied until the corresponding configuration/test/activation authorization is recorded. Proposals may request actions; they cannot grant authority.

Approval requires current OWNER/ADMIN authority and recent authentication using existing policy. The server selects permissible scope and creates or binds the installation's service principal and integration account. It does not accept a caller-selected organization, role, source or permission merely because the executable supplied it.

Initial defaults: ten-minute enrollment expiry, a 32-byte cryptographically random private secret, a separate human comparison code, five-second minimum polling and existing rate-limit middleware for starts, guesses and polling. Limit pending intents per device/IP and expire abandoned intents; the device identifier is untrusted input, not an abuse-control identity by itself. Use one approval and stop polling on denial/expiry. User codes are not sufficient to redeem credentials. No secrets in URLs, command-line arguments, browser fragments, telemetry or renderer messages. A denied or expired intent stops; retry begins only on another user action. These are application-enrollment requirements, informed by established polling and expiry practices, not an assertion of RFC 8628 compliance. [T7]

### 8.2 Lost responses and one-time issuance

Credential issuance must survive a lost network response without minting multiple active principals or tokens. Reuse the existing encrypted sensitive-command response mechanism for a brief, bounded replay to the same protected redemption secret. Persist the credential in protected storage before acknowledging enrollment. On acknowledgement, erase the recoverable secret response and invalidate the enrollment secret.

If the acknowledgement is lost, the server should recognize the already-active installation without exposing the token again. If enrollment expires before safe local persistence, revoke the unacknowledged credential and offer a fresh attempt. Concurrent redemptions and different-secret replays must be rejected. Never solve this by making the enrollment code reusable forever.

### 8.3 Required authorization restriction

The reviewed direct-merchant service credentials have organization-wide permissions within granted scopes; selecting a location in a UI is not a security boundary. Add an **installation restriction** checked by existing credential middleware and the relevant import/record authorization helpers. [R5]

Bind the installation to one organization, environment, integration account, approved location policy and assigned operator membership. Allow only the necessary import preview/commit/status, source-bound record retrieval, installation configuration, heartbeat and credential renewal operations. Deny unrelated Proof listing, event-stream access, audit export, sharing, deletion, capture attestation and signing even if a broad underlying scope string would otherwise permit them.

Enforce the restriction before accepting a command, before returning a cached response and in the existing import worker before canonical writes. Check every CSV row against the approved source/location; do not validate only the outer request. A read for a guessed record or import from another installation must not reveal its existence or metadata.

Initial support is direct merchant approval. Do not expand delegated-partner location semantics just to complete this feature. Unsupported authorization remains a visible assisted case.

### 8.4 Pause, revocation and offline collection

Pause stops new source reads and new submissions. Already server-accepted work may complete under its existing authorization; display this distinction. Revocation immediately blocks new server operations and worker processing according to current policy. The connected service learns of it through normal requests/heartbeat and stops collection.

An offline PC cannot learn about remote revocation instantly. Permit collection only within a bounded cached approval window, initially 24 hours after the last authenticated policy check; then stop new reads while preserving the existing queue. Clock rollback or uncertainty pauses collection rather than extending the window. Disclose this limitation instead of promising instant offline shutdown. Customers requiring no offline collection can set the window to zero.

---

## 9. Backend changes and contract boundaries

### 9.1 Existing routes remain the data path

| Existing route | Connect use |
| --- | --- |
| `POST /v1/partner/imports/preview` | Preserve the original and obtain the authoritative mapped preview. |
| `POST /v1/partner/imports/:importId/commit` | Commit the exact preview after approved policy/consent. |
| `GET /v1/partner/imports/:importId` | Recover status and per-row outcomes with the originating credential. |
| Existing authorized Proof read | Confirm that the resulting canonical record exists and is visible. |
| Existing connection/admin controls | Reuse current pause/revoke/audit behavior where the policy matches. |

These service routes must not be replaced with human `/me/records/imports` calls, and the Windows service must not impersonate a human session. Exact route names and capability availability are rechecked against the implementation branch. [R3]

### 9.2 Minimum new contract

The following route names are proposed. Keep equivalent existing endpoints if discovered; do not create duplicates simply to match these names.

| Proposed surface | Authority | Responsibility |
| --- | --- | --- |
| `POST /connect/enrollments` | Rate-limited untrusted installation start | Create short-lived approval intent; no organization data or permanent privilege. |
| `POST /connect/enrollments/:id/redeem` | Protected enrollment secret | Pending/denied/expired result or bounded encrypted credential delivery. |
| `POST /me/records/agent-enrollments/:id/decision` | Recently authenticated eligible administrator | Approve/deny exact requested installation and server-selected binding. |
| `GET /me/records/agent-installations` | Existing authorized workspace session | Small installation inventory for the current organization. |
| `POST /me/records/agent-installations/:id/actions` | Current administrator plus stable idempotency key | Configure, pause, resume, replace, revoke or request approved recovery. |
| `POST /v1/partner/agent/config-proposals` | Restricted installation credential | Stage an exact configuration/test/activation proposal for browser review; never activate it or expand authority. |
| `GET /v1/partner/agent/config` | Restricted installation credential | Current approved config revision, permissions, limits and expiry. |
| `POST /v1/partner/agent/heartbeat` | Restricted installation credential | Bounded operational status; server derives verified import facts. |
| `POST /v1/partner/agent/credential-renewals` | Current restricted credential and renewal policy | Quiesced, same-authority renewal; never wider scope or another source. |

Enrollment acknowledgement and renewal acknowledgement can use authenticated heartbeat fields rather than additional endpoint families. No generic agent command execution route, remote shell, upload plugin route or arbitrary callback target is allowed.

### 9.3 Data model

Prefer two additive tables: `record_agent_enrollments` for expiring intent state and `record_agent_installations` for the stable binding, current status, config revision, principal and credential references, last seen and supported version. Reuse existing integration accounts, command results, organization audit and connection state. Store immutable configuration snapshots through the existing audit/command mechanism; add a dedicated revisions table only if that mechanism cannot retain the necessary approved snapshot safely.

Do not hard-code migration numbers from this plan. Allocate the next available migration after inspecting the branch. Never edit applied historical migrations. Use existing API/worker role-grant conventions and release tooling. Add only the privileges required for the two new resources and current worker checks.

Installation metadata must not contain raw CSV rows, unrestricted filesystem listings or full credentials. Keep the local folder path local unless the customer explicitly authorizes its inclusion in diagnostics. Server-side configuration needs source identity, mapping/profile revision, approved operator/location, collection policy and capabilities, not a directory crawl.

### 9.4 Capability gating

Introduce a distinct provider/capability identifier such as `windows_folder_csv_v1`. Do not change historical `csv` imports into live sources. Enable its automatic collection only for the tested adapter version and allowed customer cohort. The existing source inventory currently distinguishes one-time imports from an unqualified automatic source; preserve that truthfulness. [R4]

Persist source, mapping, operator/location and policy changes as a proposed revision. The browser action confirms that exact revision; a service may apply only the server-approved version. A source-path change is bound through a local candidate digest without uploading the raw path. Old approvals cannot activate a different candidate.

Use a small static registry/capability declaration, not a plugin marketplace. A capability declares input format/version, access method, limits, delivery behavior and qualification evidence. An unsupported backend returns “API update required” while preserving the queue; it must not create a different ingestion path silently.

---

## 10. Export-folder connector and mapping contract

### 10.1 Producer contract

The customer's export job must write a temporary file and rename it into the approved folder only after the write completes. Final CSV files are immutable and have unique names. Retain completed exports for a documented recovery period; use seven days as the pilot default subject to the customer's policy and expected outage duration.

The connector reads final `.csv` files only, ignores temporary files, never modifies/deletes originals and does not recurse. Reject unsupported network locations, device paths, reparse-point escapes and protected/system roots. Resolve and validate paths in the service, not just in the renderer. The service verifies the opened handle remains within the approved source and takes an immutable snapshot without permitting a concurrent writer. Test rename/delete races and reparse replacement; a disappearing or changed file is retried or flagged, not recorded as safely staged.

Do not promise correctness for arbitrary overwriting export jobs. An in-place snapshot, repeated changed shipment reference or an exporter without a safe completion signal needs a separately specified adapter. File “quiet for a few seconds” is not a substitute for the agreed producer contract.

### 10.2 Collection strategy

Use a bounded directory enumeration every 30 seconds as the correctness path. Filesystem notifications may later improve responsiveness but are not required for v1. Keep a durable inventory of file identity, digest and disposition. On service startup, recovery and schedule, reconcile the folder to the inventory; do not rely on a fragile “last modified time” cursor.

A full directory produces a visible source-capacity warning rather than an unbounded recursive scan. Configure a dedicated export folder and an agreed producer retention/archive policy. PackProof must not archive the customer's originals itself in this release.

Capture the immutable original into an encrypted, durable local snapshot before marking it staged. Include file digest, bytes, original filename (protected), source namespace, mapping revision and source-reported time when available. The digest identifies content; it does not attest to shipment condition.

### 10.3 Mapping and validation

Suggest mappings using exact header matches and a small reviewed synonym list. A suggested mapping remains a suggestion until the user confirms it. Do not infer shipment identity from tracking number alone. Preserve leading zeros, original strings and explicit time zones.

Use the existing CSV schema: stable shipment reference, description, supported integer quantity, optional tracking/carrier/shipment date/location. When a location-bound installation requires a location, the export must supply the authorized location value unless the current API explicitly supports an approved default. Do not silently create a default-location feature or weaken the restriction to accept an incompatible export. Do not add case-to-unit conversions or item grouping to this first adapter. If source quantities mean cartons, pallets or fractional units, explain the mismatch and request a compatible export or later adapter; never relabel them as individual items.

Local structural preview can show the first 20 rows and header/encoding problems. Server preview validates every row and is authoritative. Required mappings cannot be omitted, conflicting source references cannot be auto-overwritten, and ambiguous dates/units cannot be guessed. A mapping change creates a new approved version; it never reinterprets an already accepted original.

### 10.4 Limits and consent details

Use the lesser of documented client limits and server-advertised limits. Bound both decoded CSV size and HTTP JSON wire size; escaping a CSV into JSON can increase the request body. Preserve BOM and exact UTF-8 content according to the current API contract; test the server original digest against the local original digest. Reject or clearly route oversized files to assisted export correction. Do not silently split a source original into unrelated receipts.

At initial setup, require a completely valid bounded preview for the first verification. For continuous imports, default to holding a file with invalid/ambiguous rows. Permit “import valid rows and report exceptions” only as an explicit administrator-approved policy represented by the existing `importValidRows` behavior. Reconcile each row outcome; a partially succeeded file is not a completed connection check.

---

## 11. Queue, recovery and duplicate prevention

### 11.1 Durable queue model

Store a file-level record with queue ID, installation/source/config identity, protected original location, source digest, exact request-body digest, preview/commit idempotency keys, credential generation, server import ID, row counts, attempt count, next attempt, last safe error and final disposition.

Use states such as `staged`, `preview_pending`, `awaiting_review`, `commit_pending`, `server_processing`, `complete`, `partial`, `action_needed` and `paused`. A network timeout is not proof of failure. Keep “unknown response” represented by the existing pending operation, not by a new record.

Write/fsync the encrypted spool before committing its database reference. On restart, recover committed references and safely inventory orphaned temporary files. Never report durable staging until the filesystem/database recovery invariant is established. Use SQLite transactions and its supported journal mode; do not create an append-only database engine.

### 11.2 Stable identity rules

File identity is source-scoped content identity, not merely its filename. Renaming an identical file should not create new work. Shipment identity remains the backend's permanent organization/environment/integration-account/shipment-reference binding. Both layers are necessary: different exports may legitimately contain the same shipment.

Generate a preview command key and commit command key before the first request and persist them. Retries use the same method, path, body and key. A changed mapping or payload requires a new preview/command. Do not regenerate a UUID on each retry.

After an uncertain preview response, retry the same preview command. After an uncertain commit response, first read the existing import receipt, then retry only according to its state. Poll until terminal row outcomes; retrieve the accepted Proof for setup verification. Never treat a successful HTTP upload or `202 Accepted` as a completed import. [R3]

### 11.3 Retry classification

Retry transient network failures and documented 408/429/5xx responses with bounded exponential backoff and jitter, honoring `Retry-After`. The HTTP helper performs at most three immediate attempts; after that, the durable queue schedules a later attempt. Do not multiply three transport retries by multiple independent retry loops.

Treat 401/403 as an authorization action, 409 as a conflict to review, and incompatible capability/version as a paused integration. Preserve per-row failures and the original receipt. Avoid retries for malformed mapping or unsupported data until a user changes the cause.

A proposed default is a 2-second initial delay, 5-minute cap and a visible warning after ten scheduled failures or 30 minutes of unprocessed eligible data, whichever occurs first. Do not permanently discard transient work at that threshold. Keep pending work until it is acknowledged or explicitly handled under the recovery policy.

### 11.4 Offline, full disk and replacement

Only durably staged bytes are covered by the no-loss guarantee. Files that disappear from the source before staging are not recoverable by this agent; the producer retention requirement matters. On quota/full disk, stop reading new files, preserve queued work and report backlog. Do not delete the oldest pending evidence to make the dashboard green.

On reinstall, reuse the protected installation identity and queue only after confirming the same environment and source. Changing organization/environment requires draining or explicitly preserving the previous installation's isolated data. Do not relabel its pending work to a new account.

On a new PC, enroll a new installation and replay retained source exports under the same authorized source namespace. Server deduplication prevents duplicate shipments. If changed source bytes conflict with an existing shipment, preserve and surface the conflict; do not force overwrite to complete migration.

---

## 12. Health, diagnostics and resource budgets

### 12.1 Four distinct health questions

Show **service online**, **folder access / last scan**, **last observed export**, and **last completed PackProof import** separately. A live process or an empty folder scan does not prove that the upstream ERP is current. Without a provider watermark or export schedule, show “Watching folder; source freshness unknown,” not “All systems up to date.”

The initial folder connector reports collection cadence and last export time. An administrator may declare an expected export schedule and grace period; only then flag a missing expected export. Quiet periods, weekends and empty sources are not automatically failures. Record the schedule/time zone instead of assuming 24/7 shipments.

Heartbeats carry bounded operational counters and local observations. The backend derives completed import counts/receipt references from its own records. A client-reported successful upload must not set server verification or evidence integrity status.

### 12.2 Proposed operating defaults

| Control | Initial default / acceptance target |
| --- | --- |
| Folder scan | 30 seconds; bounded nonrecursive enumeration; 10,000 final files maximum before a capacity action |
| Concurrent imports | One file in flight per installation; preserve ordering and simple recovery |
| Heartbeat / policy refresh | 60 seconds while online; back off when unavailable |
| Local spool | 1 GiB or 10,000 files, whichever comes first; pause admissions before exhaustion |
| Free disk reserve | 1 GiB; do not consume the last available disk space |
| CSV limits | Server-advertised bounds, initially no greater than the reviewed 2 MiB / 1,000 rows / 50 columns |
| Completed local payload cleanup | After 24 hours and confirmed terminal success, subject to approved local retention policy |
| Failed/uncertain payload cleanup | Never automatic solely due to age; retain within the bounded spool and require an explicit resolution |
| Agent idle resources | Engineering target below 150 MiB resident memory and 1% average CPU on the reference PC |
| Setup responsiveness | Local transitions respond within 200 ms; network operations show bounded waiting and cancellation |

Numbers above are proposed defaults, not measured performance claims. Validate them against the agreed workload before release. If capacity is inadequate, first adjust a documented budget or source export size; do not introduce distributed processing.

### 12.3 Support bundle

Export a previewable bundle containing app/service versions, environment, installation/source IDs, safe config revision, timestamps, service state, queue counts/ages, redacted error codes, request IDs and relevant receipt IDs. Exclude bearer values, enrollment secrets, customer rows, exact source paths by default, media and signed storage URLs.

The user chooses whether to share it. Do not automatically send email or create external tickets without a configured, authorized support route. Retain diagnostic logs with fixed rotation and disk limits. Never log a request/response body by default just because a test failed.

---

## 13. Credential renewal, upgrades and uninstall

### 13.1 Renewal without stranded work

The reviewed service-import contract checks the originating credential, not just organization membership. Replacing a token while jobs still need that credential can strand their status/recovery path. Do not assume a fresh key automatically owns old operations. [R3]

Use a server-approved credential lifetime, initially 30 days unless existing policy requires less, and begin renewal seven days before expiry. Recheck the active installation, source binding, organization entitlement and exact allowed scope. Automatic renewal can only preserve or reduce authority; it cannot approve a new source or location.

Before renewal, stop new remote submissions and drain all server-accepted imports to terminal outcomes using the old credential. Local approved staging can continue within its quota and authorization window. Persist terminal receipt summaries. If an import is stuck, surface the cause and keep the old credential until resolved or its existing expiry; do not revoke it merely to make rotation finish.

Issue the successor through an idempotent, encrypted-replay renewal command. Preserve the old credential for a maximum ten-minute acknowledgement window, limited to renewal recovery after quiescence. Persist the new secret before sending its authenticated acknowledgement; then revoke the predecessor. Lost responses must replay the same successor, not create more credentials. If persistence fails, revoke the unacknowledged successor and retain the still-valid predecessor. Test both sides of every crash boundary.

An already expired/revoked credential requires a new browser approval and explicit recovery. Do not grant a replacement access to old credential-bound receipts implicitly. Where necessary, replay the preserved original into a new authorized receipt under the same permanent source namespace, reconcile already-created rows through backend deduplication, and retain the old receipt reference. Conflicts remain review items.

This is a small extension of existing principal/credential issuance and sensitive-response handling, not a general secret-rotation platform. Hardware attestation and certificate management are not required for it.

### 13.2 Signed packaging and updates

Build one per-machine NSIS executable containing the local UI and self-contained Windows service. Give Connect distinct application ID, service name, protocol (only if required), update feed and ProgramData directory. It must coexist with PackProof Desktop without touching that app's evidence queue.

Sign the installer and PackProof-owned executable components, timestamp signatures and verify expected publisher identity in the build and update path. Preserve upstream signatures where applicable and inventory all shipped executable dependencies. Use existing release controls rather than creating a certificate procurement or updater platform inside this task. A missing signing credential blocks public distribution, not ordinary source development. [R2, T5]

For v1, use automatic update notification/download and an explicit, elevated installation step with the existing trusted installer mechanism. Do not promise silent enterprise upgrades. Before replacement, pause new collection, checkpoint the queue, stop the service, install a compatible package, migrate local metadata transactionally and restart. Test the exact signed package as a standard user and after reboot.

Prefer additive local schema changes readable by the previous supported version. Where downgrade is unsafe, block it with a clear explanation instead of restoring an old database snapshot and losing new queue entries. A failed binary upgrade may roll back binaries only when schema compatibility is proven. Keep queue/spool data intact throughout.

Code signing does not guarantee that a new download avoids SmartScreen warnings. Document publisher verification and an enterprise IT route without telling users to disable protection. Do not buy a more expensive certificate or rewrite packaging on the assumption that this guarantees instant reputation. [T6]

### 13.3 Repair and uninstall

Repair may restore application files, service registration and expected ACLs; it must not reset enrollment, configuration, pending receipts or encryption keys. Uninstall stops/removes the service and UI while preserving queued data by default. Explain what remains and where it can be managed without exposing customer data to other users.

Keep the queue encryption key when preserving encrypted work. Credential revocation and local evidence cleanup are separate actions. Offer an authenticated Disconnect/revoke step before uninstall; if offline, state that server revocation is still pending and direct the administrator to the portal. Do not claim that removing the program remotely revoked its grant.

Never delete cloud records, source exports or the existing Desktop evidence store on uninstall. A separately authorized cleanup operation can remove eligible local completed data; pending/uncertain data requires explicit reconciliation or a recorded informed discard decision under the applicable policy.

---

## 14. Security, privacy and focused threat tests

### 14.1 Boundaries that must survive simplification

Electron uses local packaged content, renderer sandboxing, context isolation, no renderer Node integration, strict navigation/CSP and a small validated preload interface. Do not expose generic IPC dispatch, shell execution or arbitrary HTTP methods. External navigation is restricted to trusted PackProof origins. Follow the existing hardened desktop patterns and Electron's guidance. [R2, T8]

Use a local-only named pipe with an explicit DACL, message limits, schema validation, timeouts and allowed caller identities. Deny remote network clients. Default pipe security is not an adequate application-specific authorization policy. The UI must verify that its peer is the expected service process rather than a pipe-name impostor. Do not add an unauthenticated localhost web server as a shortcut. [T9]

For HTTPS, keep certificate/hostname validation enabled. Trust customer-managed roots only through supported Windows trust configuration. Do not install a root certificate, set insecure TLS environment flags or instruct a customer to bypass endpoint protection. Proxy settings must be tested in the service context, not just the browser.

### 14.2 Security acceptance cases

| Case | Required result |
| --- | --- |
| Another local Windows user calls the pipe | Denied; no status containing source/customer data and no privileged action. |
| Remote computer opens the named pipe | Denied explicitly; no reliance on “it is probably local.” |
| Renderer sends arbitrary path, URL or command | Rejected before IO; only approved typed operations are supported. |
| Unauthorized source/location in a CSV row | Backend and worker deny it; outer body validation alone is insufficient. |
| Guessed Proof/import ID from another source | Denied without leaking its metadata. |
| Replay expired/denied enrollment | No new credential or principal; safe actionable error. |
| Lost enrollment/renewal response | Same bounded result, no duplicate credentials; secrets never logged. |
| Token copied into another organization request | Existing organization and installation restrictions still deny it. |
| CSV contains HTML, formula text or hostile instructions | Display as inert data; no script/formula execution; correction exports remain formula-safe. |
| Source path replaced with a reparse escape | Service rejects it; reads remain inside the approved folder contract. |
| Tampered update or wrong publisher | No execution; keep the working installation and queue. |
| Protected storage or decryption unavailable | Fail closed; no plaintext fallback or deleted queue. |

These are required targeted checks. They do not authorize an agent to launch an open-ended security redesign of the entire company. Existing independent review obligations remain release requirements; compile success is not a substitute.

### 14.3 Privacy and retention

Explain which local data is read, that originals are preserved by PackProof, what stays on the PC and how uninstallation differs from deletion. The customer approves the export's full contents before the first cloud preview. Store only permitted data and keep support telemetry content-free.

Do not claim imported records prove the physical condition of a shipment. Label source assertions accurately; service-generated records never impersonate an employee's personal attestation. Existing signing, capture and retention boundaries remain unchanged.

---

## 15. Implementation work packages

Execute in dependency order. Each package ends with working code and named evidence, not only documentation. IDs are stable handoff references, not a requirement for a new project-management system.

### W01 — Confirm the baseline and build path

**Depends on:** Nothing.  
**Work:** Read repository instructions, exact branch/head, the files in Section 2 and existing Windows workflows. Confirm current service-import capabilities and identify the intended staging environment. Record existing equivalents and genuine gaps in one short status file. Establish one native Windows CI job producing an internal development package.  
**Done when:** An exact-source build artifact exists or one precise toolchain/access blocker is recorded with its failing command.  
**Avoid:** Full repository audit, mass dependency upgrades, production activation, unrelated mobile builds or a second requirements document.

### W02 — Native service and secure UI bridge

**Depends on:** W01.  
**Work:** Add the small Worker Service, service identity/ACLs, protected storage smoke test, local-only pipe protocol and Electron bridge. Add start/stop/status, schema version and graceful shutdown. The development installer registers the service but leaves collection disabled.  
**Done when:** Closing the UI and logging out do not terminate the service; reboot starts it; another local user and a remote pipe client are denied.  
**Avoid:** Writing a service wrapper, running Electron as the service, adding a second agent runtime or building a remote-control console.

### W03 — Enrollment and installation restrictions

**Depends on:** W01; integrates with W02.  
**Work:** Add minimal enrollment/installation persistence, browser approval, existing principal issuance, restricted route/source/location authorization and revocation. Include current worker checks and OpenAPI declarations for new routes.  
**Done when:** A recent eligible administrator can enroll exactly one installation; replay, cross-tenant/source access, expiry and lost responses are covered; no service token reaches the renderer.  
**Avoid:** New identity provider, OAuth server, user role system, certificate authority or delegated partner-location redesign.

### W04 — Durable queue and protected spool

**Depends on:** W02.  
**Work:** Implement encrypted local snapshots, SQLite state, stable request keys, transactional checkpoints, quotas, startup recovery and a single scheduled retry loop. Test with a fake HTTP transport before connecting to staging.  
**Done when:** Crash/restart at each state boundary preserves every durably staged original and its stable keys; full disk pauses collection without deletion.  
**Avoid:** Database server installation, a custom journal engine, multiple workers, message brokers or unbounded storage.

### W05 — First vertical slice: export to visible record

**Depends on:** W03 and W04.  
**Work:** Implement the strict immutable-file folder adapter, local structural preview and thin import HTTP client. Reuse server preview/commit/status and canonical record retrieval. Add synthetic good/invalid/duplicate/changed-reference fixtures.  
**Done when:** A synthetic export on a real Windows runner reaches an approved nonproduction backend, produces a durable receipt and opens the expected record; replay does not create another shipment. A mocked backend alone does not meet this gate.  
**Avoid:** SQL, generic artifact ingestion, camera capture, domain-model changes or constructing Proofs directly in the service.

### W06 — Complete the seven-step experience

**Depends on:** W02 and W03; final integration after W05.  
**Work:** Build every screen and genuine waiting/error/resume state. Add local/cloud-preview consent, mapping confirmation, first-record verification and activation. Replace all prototype timers/status flags; implement invalidation on config changes.  
**Done when:** A fresh authorized user can complete the supported synthetic journey without command-line steps or key copying; back/change/reopen cannot retain stale success.  
**Avoid:** Cosmetic redesign of the rest of PackProof, unnecessary animation frameworks or recreating the full records dashboard.

### W07 — Connection health and support controls

**Depends on:** W05 and W06.  
**Work:** Add the distinct folder-source capability, heartbeat, existing portal source entry, real receipt-backed health, pause/resume/re-test and previewable diagnostic export.  
**Done when:** Source silence, stopped service, network outage, partial import and authorization loss have different truthful messages; a fake success heartbeat cannot fabricate completed records.  
**Avoid:** A fleet-management product, new monitoring vendor, automated support outreach or a fabricated ERP freshness watermark.

### W08 — Credential lifecycle and replacement

**Depends on:** W03–W05.  
**Work:** Implement drain-before-renewal, restricted same-authority issuance, bounded acknowledgement/replay, expiry behavior and administrator-approved replacement/recovery.  
**Done when:** Lost responses, crash during storage, pending imports, expiry and revocation do not lose work or transfer another credential's authority.  
**Avoid:** Immediate old-token revocation while jobs need it, blanket receipt reownership, indefinite recovery tokens or hardware key infrastructure.

### W09 — Signed install, update, repair and uninstall

**Depends on:** W02 and W04; release validation after W06–W08.  
**Work:** Complete NSIS hooks and separate identity, publisher verification, standard-user launch, checkpointed updates, compatible rollback, repair and retention-safe uninstall. Produce checksums and exact-source artifact inventory.  
**Done when:** Clean install, same-version repair, N−1 upgrade, failure recovery, coexistence with Desktop, reboot and uninstall all pass using the actual candidate package.  
**Avoid:** MSI/MSIX conversion, app-store submission, multiple install modes, a bespoke update service or bypassing signature enforcement.

### W10 — Focused hardening and regression acceptance

**Depends on:** W05–W09.  
**Work:** Run Section 16 tests, Windows security cases, realistic quota/resource checks and UI accessibility review. Run affected backend/portal tests plus required repository CI on the exact candidate. Fix failures attributable to the changes.  
**Done when:** Required cases pass with named evidence; unrelated existing failures are reproduced on baseline and reported without weakening merge/release policy.  
**Avoid:** Repository-wide cleanup, test-count chasing or repeatedly rerunning unrelated suites without a new hypothesis.

### W11 — Real source and novice acceptance

**Depends on:** W10 and customer prerequisites.  
**Work:** Confirm the real export contract and installation permissions with one named source owner. Reconcile a bounded authorized dataset and observe first-time users without coaching. Record failures and fix the setup problems they reveal.  
**Done when:** The named source works, its limitations are documented and the actual user outcomes meet Section 18.  
**Avoid:** Claiming all WMS products are supported or inventing a customer test when access is unavailable.

### W12 — Publish and hand over

**Depends on:** W10, W11 and release credentials/authorization.  
**Work:** Use existing deployment/signing channels, enable only the accepted source/cohort, publish the installer and installation guide, and perform one fresh-download canary against the intended environment. Record exact backend, website and binary versions.  
**Done when:** Download, install, approval, real import, visible record and recovery are verified for the released artifact; the operator runbook and outstanding limitations are delivered.  
**Avoid:** Marking source merge as deployment, changing unrelated cloud roles or starting another architecture cycle after acceptance.

### Parallel work rule

After W01, the backend enrollment work and native service foundation may proceed independently if separate agents are available. UI work may use typed fixtures while those contracts stabilize. Assign nonoverlapping files and one owner for migrations/contracts. Do not create more parallel tracks than there are independent boundaries, and do not merge inconsistent mock contracts.

---

## 16. Test plan and release gates

### 16.1 Minimum regression matrix

| ID | Scenario | Required assertion |
| --- | --- | --- |
| T01 | Clean install by standard user with administrator assistance | Clear elevation; UI/browser return to the original user's context. |
| T02 | UI closed, logoff, reboot | Approved collection continues independently of the interactive session. |
| T03 | Service cannot read a user-visible folder | Setup blocks with the exact access remedy; no false pass. |
| T04 | Valid CSV with leading-zero IDs, BOM and quoted fields | Original digest matches; mapped values and source identities remain correct. |
| T05 | Ambiguous date/unit, duplicate header, invalid row | Review required; no guessed value or silent partial import. |
| T06 | Duplicate file, rename, overlapping exports | No duplicate canonical shipment; durable receipt outcomes stay traceable. |
| T07 | Same source shipment with changed content | Conflict preserved; earlier assertion not silently replaced. |
| T08 | Crash after spool write / before DB commit | Recovery handles the orphan without reporting unstaged work as accepted. |
| T09 | Lost preview/commit/status response | Stable replay; one intended import effect, no invented completion. |
| T10 | Server worker delayed or partially succeeds | Honest pending/partial state and per-row recovery. |
| T11 | 24-hour simulated offline window and real network interruption | Bounded authorization/queue behavior; reconnect reconciles without loss of staged work. |
| T12 | Disk full, file quota, database corruption | Safe pause; originals retained; corruption not silently replaced by an empty queue. |
| T13 | Pause/revoke during queue processing | Authorization rechecked; already accepted versus pending work explained. |
| T14 | Renew token with unresolved imports and lost replies | No stranded receipt or duplicate successor credential. |
| T15 | Another tenant/source/location/operator in request or row | Denied at API and worker boundaries. |
| T16 | Unauthorized local user / remote pipe client / pipe impersonator | No credential, preview or control access. |
| T17 | Proxy, invalid TLS chain, clock skew and blocked egress | Actionable failure; no insecure fallback. |
| T18 | Upgrade/rollback, repair, uninstall/reinstall with pending files | Queue and identity preserved appropriately; no unsafe downgrade. |
| T19 | Tampered package or wrong publisher | Rejected; last working installation unaffected. |
| T20 | Existing PackProof Desktop installed | Its app identity, updates and evidence queue remain unchanged. |
| T21 | Back navigation, changed mapping/source, browser cancellation | Stale verification invalidated; saved progress can recover. |
| T22 | Keyboard, screen reader, 200% scale, reduced motion | Complete supported setup without blocked controls or hidden errors. |
| T23 | Diagnostic export with seeded secrets and personal data | Secrets/rows/paths excluded unless explicitly approved; no accidental upload. |
| T24 | Idle source with no declared export schedule | “Freshness unknown” rather than a fabricated all-current state. |
| T25 | Fresh production download and actual approved export | Released artifact and live APIs form the expected canonical record. |

For simulated long outages use an injected clock and deterministic transport, then validate representative real Windows/network interruptions. Do not spend a full agent run waiting 24 hours. Native install, permissions, logoff/reboot and signature behavior still need actual Windows evidence; Linux mocks cannot establish those facts.

### 16.2 Completion gates

**G0 — Buildable foundation:** Exact-source development package, service start/stop, protected storage and secure bridge. Signing may still be pending; artifact is internal only.

**G1 — Working vertical slice:** Real Windows service → approved nonproduction backend → durable receipt → visible canonical record, with duplicate and lost-response recovery. This is the first meaningful engineering milestone.

**G2 — Release candidate:** Full guided flow, renew/revoke, quotas, updates/repair/uninstall, security/accessibility checks and affected regression CI pass. Signed candidate identity is recorded. No customer-support claim yet.

**G3 — Accepted pilot:** One named real source, source owner, export format/version, permissions, reconciled dataset and user outcomes. A passing generic CSV fixture alone is insufficient.

**G4 — Published supported release:** Verified download, intended backend/cohort, exact signed artifact and fresh install canary. Publish the precise support matrix and support route. Deferred adapters are not hidden blockers for this accepted scope.

A missing external prerequisite blocks only its downstream gate. It does not erase completed work or justify endlessly rebuilding passing components.

---

## 17. Coding-agent operating rules and stop conditions

### 17.1 Start with a bounded inspection

Read the root instructions, this plan and the specific existing modules in Section 2. Capture branch/head, changed files, target environment and tool availability. Limit initial discovery to the work package being started. Do not turn every task into another complete PackProof audit.

Produce only three short living records: the work-package status, a blocker list and a test/release evidence manifest. Reuse existing project records where possible. Do not generate overlapping plans, handoff documents and checklists after each edit.

### 17.2 Execution discipline

Work one vertical slice at a time. The first native package and service smoke test happen in W01–W02, not after the entire UI and all APIs are finished. Keep the installer buildable throughout. When an acceptance criterion passes, mark the exact evidence and move forward; do not repeatedly rewrite a passing component to make it more “enterprise.”

For an uncertain technical detail, permit one bounded spike with a concrete output: for example, proving DPAPI under the real service identity or a native installer privilege transition. State the question and expected test before starting. If it fails, record the failure and either repair that mechanism or use an already-proven equivalent. Do not start a framework bake-off.

Use narrow tests during development. Run broader affected suites after an integrated slice and required CI before merge/release. Never disable a test, weaken a security rule, modify historical migration bytes or fake capability status to achieve green results.

### 17.3 Retry and blocker policy

For the same external blocker, make at most two retries **after a concrete diagnosis or changed condition**. An unchanged 401, missing secret, denied repository operation or inaccessible customer system is not solved by twenty identical attempts.

After that, record: the failing step/command, error class, last verified state, why it is external, affected gate, exact required owner/admin action and independent work still possible. Continue unblocked implementation and testing. Do not label missing credentials as broken business logic or refactor the application to bypass them.

Transient test failures need a hypothesis, not blind repetition. Reproduce an apparently unrelated failure against the baseline once when practical. A baseline failure remains a merge/release policy issue to disclose; it does not authorize silently ignoring required checks or performing an unrelated rewrite.

### 17.4 Changes outside the scope

Do not alter mobile apps, core Proof state transitions, signing policy, unrelated cloud roles, database recovery protections or website marketing content unless a specific accepted Connect dependency requires it. Name that dependency and make the smallest compatible change.

Do not introduce a new runtime/framework beyond the prescribed Windows service, generic plugin system, external infrastructure service or connector family without a documented concrete necessity and scope decision. A suggestion in the roadmap is not permission to implement it.

Routine code edits, tests, builds and work-package fixes should proceed without repeatedly asking Collin for decisions already settled here. Obtain missing business/customer consent, account access, legal/signing authorization or destructive-operation approval rather than inventing it. Consolidate owner requests.

### 17.5 Definition of finished work

The agent may stop a package when its done condition is met and evidence recorded. It should not keep adding safeguards unrelated to the actual boundary. Conversely, it must not call a package done merely because files were created or tests were mocked.

Final handoff states: exact commits, artifacts, named tests and outcomes, installed/deployed versions, supported source, remaining blockers, owner actions and deferred scope. Include failures and skipped tests. Do not claim to be continuing work in the background unless an actual authorized job is running and its status is available.

---

## 18. Customer acceptance and measurable success

### 18.1 Setup usability

Run an initial formative study with at least five representative first-time users. Report exact outcomes such as “4 of 5 completed without help,” not a statistically strong population success claim. Any failure involving wrong-organization approval, misunderstood data upload, lost work or false success is a release blocker.

The design target is a median supported setup of ten minutes or less once prerequisites are available. Measure both active user time and total elapsed time from download through the first visible record, including waits. Record prerequisite delays separately: IT approval, unavailable export, account eligibility and corporate network changes. Do not hide those delays in customer-facing promises.

Track no-code completion, manual assistance, failure step, recovery success and whether users can explain what is read, what is uploaded, when collection runs and how to pause it. A polished wizard that requires the founder to interpret errors has not met the goal.

For larger later samples, estimate unassisted completion rate and timing distributions with sample size and uncertainty. Do not make p95 or 90% reliability claims from five observations. No analytics platform replacement is necessary; existing consented events and a structured study sheet are sufficient.

### 18.2 Source correctness

Reconcile a customer-approved bounded dataset: source file count, original digests, valid/invalid/duplicate/conflict row counts, server receipt outcomes and resulting unique shipment records. Include at least one interruption, repeat file and changed-reference conflict. Resolve or explain every discrepancy; silently dropping bad rows is not reconciliation.

Confirm that a missing new export is distinguishable from a stopped PackProof service. Confirm that an actual service identity can read the approved source after logoff/reboot. Record the supported exporter/version, file completion behavior and retention requirement.

### 18.3 Operational readiness

Before publishing, identify the real person/team responsible for source access, PackProof support and deployment. Provide a short user guide, IT prerequisite sheet and operator recovery runbook. These are practical handoffs, not a claim that a staffed 24/7 support service already exists.

Agree a short pilot observation window covering at least one representative shipment cycle, interruption recovery and an update/repair exercise. Use the existing records release process where it already sets a required observation period; do not create a competing one or invent acceptance while the period is incomplete.

---

## 19. External prerequisites and deferred expansion

### 19.1 Blocker register

| Prerequisite | Blocks | Continue without it |
| --- | --- | --- |
| Writable repository / Windows CI access | Committing or native validation | Local source work and nonnative contract/UI tests, clearly labeled |
| Active nonproduction organization and import API | G1 actual end-to-end result | Fake-transport service tests, UI states, packaging and policy tests |
| Windows signing identity / release permission | Signed/public artifact | Internal development package and source validation |
| Actual customer export and source-owner consent | Named customer qualification | Generic connector fixtures and recovery tests |
| Customer admin rights / folder permissions | That installation's activation | IT handoff and remaining engineering |
| Approved production capability/migration/roles | Live release | Signed staging acceptance and exact deployment request |

Check these early once. Do not let a missing customer CSV block building the generic folder collector, and do not let a finished collector stand in for customer qualification.

### 19.2 Expansion triggers

**Read-only SQL/ODBC:** Start only when a named customer cannot provide the supported export and supplies an approved schema/access contract. Build one versioned adapter, not arbitrary query generation.

**Network share / Windows Server:** Start when a pilot requires it and IT provides the service identity, share permissions and target OS. Prove service-context access and reconnect behavior; do not assume mapped drives survive logoff.

**Other cloud connectors:** Start from a documented provider authorization and data contract. Keep the no-install path first. Do not require a Windows agent merely to make the product look consistent.

**MSI/Intune, fleet rollout and silent updates:** Start when an actual enterprise deployment requirement exists. Preserve the same worker and API contracts; packaging breadth is not a new product architecture.

**Additional evidence and robotics:** Add only through separately scoped existing API extensions. This installer project does not absorb camera, media, OCR, digital-twin or robot-validation development.

### 19.3 Final once-over results

The review removed or constrained: universal discovery, custom installation PKI, a duplicated import engine, a full SDK port, dual install modes, silent-success UI, new monitoring infrastructure, open-ended adapter work and repeated external retries. It added explicit handling for service-account permissions, whole-file preview consent, stale verification, credential-bound receipts, immutable export completion, offline revocation limits and safe update rollback.

The remaining work is substantial because reliable unattended software needs real lifecycle and recovery behavior. It is bounded: one platform, one source contract, one service, one existing cloud data path and explicit acceptance gates.

---

## 20. Coding-agent handoff prompt

> Implement this plan in the existing PackProof repository. Treat Sections 1–6 as architecture/scope decisions, Sections 7–14 as product and safety contracts, W01–W12 as the execution sequence, and Sections 16–18 as acceptance. First refresh the exact branch and current equivalents once. Reuse working code; do not rebuild the backend, portal, auth, import engine or desktop capture application. Produce an internal Windows package early, then prove a real nonproduction export-to-record vertical slice before expanding polish or support breadth. Replace every simulated prototype state with real checks. Maintain one short work-package status and blocker list. After two diagnosed retries of the same unchanged external blocker, stop retrying it and continue independent work. Do not weaken authorization, integrity, durability, tests or signing to finish. Report exact source/artifact/test/deployment evidence, remaining external requirements and deliberately deferred work. Do not claim live/customer completion without G3–G4 evidence.

---

## 21. Sources and evidence notes

Repository observations describe source, not deployed capability. Links below are source references for the implementer, not instructions to browse unrelated systems. Official platform documentation was checked November 6, 2026; pin build versions and recheck support/security notices when implementation begins.

### Repository and supplied reference

**[R1] Windows Connect RFC and draft PR 146.** RFC source `29ab13fe2d654eb04babe9e1dc89e6844a2c51ce`; PR base `a42c10653258b63217043f8670b94ca87a233684`. https://github.com/thepackproof/packproof-v2/pull/146

**[R2] Existing desktop application and packaging.** `desktop/README.md`, `desktop/electron-builder.config.cjs`, `desktop/docs/RELEASING.md` in the reviewed repository; use the implementation branch for the current signed-release configuration. https://github.com/thepackproof/packproof-v2/tree/a42c10653258b63217043f8670b94ca87a233684/desktop

**[R3] Service CSV imports and fixed canonical exports.** Source limits, immutable originals, credential ownership, idempotency and durable row outcomes. https://github.com/thepackproof/packproof-v2/blob/a42c10653258b63217043f8670b94ca87a233684/docs/api-portal-v1/CANONICAL_IMPORTS_EXPORTS.md

**[R4] Records connection implementation.** One-time CSV classification, source freshness and automatic-adapter qualification boundary. https://github.com/thepackproof/packproof-v2/blob/a42c10653258b63217043f8670b94ca87a233684/backend/src/records/connections.ts

**[R5] Additive partner operations.** Direct merchant scope, delegated-location limitations and truthful source health. https://github.com/thepackproof/packproof-v2/blob/a42c10653258b63217043f8670b94ca87a233684/docs/api-portal-v1/PARTNER_OPERATIONS.md

**[R6] API/portal continuation, November 4–5, 2026.** Historical source and release/qualification separation; not a fresh live-environment inspection. https://github.com/thepackproof/packproof-v2/blob/a42c10653258b63217043f8670b94ca87a233684/docs/api-portal-v1/CONTINUATION_2026-11-04.md

**[R7] Supplied interactive concept.** `PackProof_Connect_Interactive_Concept.html`; explicitly simulated screens, checks and sample records. Used for UX intent only.

### Primary technical references

**[T1] Microsoft: Create a Windows Service using BackgroundService.** Native Worker Service hosting and deployment. https://learn.microsoft.com/en-us/dotnet/core/extensions/windows-service

**[T2] Microsoft: .NET support policy.** .NET 10 LTS selection; patch/support policy. https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core

**[T3] Microsoft: LocalService Account.** Minimal local privileges and anonymous network credentials. https://learn.microsoft.com/en-us/windows/win32/services/localservice-account

**[T4] Microsoft: CryptProtectData.** User/machine protection scope; machine-scope encryption is not per-user access control. https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata

**[T5] electron-builder: NSIS configuration.** Installation mode/elevation and customization options. https://www.electron.build/docs/nsis/

**[T6] Microsoft: SmartScreen reputation for Windows app developers.** Signed new binaries can still receive warnings; publisher/file reputation. https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation

**[T7] RFC 8628.** Reference for expiring approval codes and bounded polling behavior; this plan does not claim a custom approval broker is an OAuth implementation. https://www.rfc-editor.org/rfc/rfc8628

**[T8] Electron: Security.** Sandboxing, context isolation, restricted IPC and navigation. https://www.electronjs.org/docs/latest/tutorial/security

**[T9] Microsoft: Named pipes; security and access rights.** Explicit DACLs, remote-client restrictions and caller authorization. https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipes and https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights
