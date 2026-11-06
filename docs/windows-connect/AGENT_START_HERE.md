# PackProof Windows setup — coding-agent entry point

Read [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) before implementation.
This is the entry point, not a competing specification. Document date: November 6, 2026.

## Outcome
Deliver a signed Windows installer and guided source connection that produces a real, authorized PackProof record with dependable unattended collection. The API remains hosted. Start with one immutable local CSV export-folder connector, not universal ERP/WMS integration.

## First actions
1. Inspect repository instructions, exact branch/head and the existing equivalents cited in Section 2. Do not repeat a complete codebase audit.
2. Follow W01–W12 in Section 15. Produce an internal native Windows package early. Prove the service-to-existing-import-API-to-record vertical slice before adding breadth.
3. Maintain one status file, one blocker list and one evidence manifest. Keep source implementation, test verification, deployment and customer acceptance separate.

## Fixed boundaries
- Reuse existing React/Electron presentation, NSIS release patterns, organization policy, service credentials, service CSV preview/commit/status, source bindings and portal.
- The default new worker is a small self-contained .NET 10 Windows service. This is not a backend/API/SDK port. Reuse an already-accepted existing service instead if W01 proves one is present.
- One per-machine install; Windows 11 x64; one organization/environment/source; one local NTFS folder. Do not build per-user, Linux/Mac, SQL, UNC/SMB, drivers or arbitrary plugins as part of this release.
- No custom installation PKI, new OAuth server, local API/database server, general .NET SDK, monitoring platform or custom updater.
- The seven-screen concept supplies visual intent only. Replace every simulated flag/timer with real state, and invalidate verification when its inputs change.

## Pitfalls already resolved in the full plan
Browser enrollment begins setup-only. The server requires current human approval of the exact configuration and activation proposal. A local service may propose changes; it cannot authorize them.

Cloud preview uploads and preserves the whole CSV original, including unmapped columns. The existing commit API commits the batch. Use a one-row setup export or explicitly approve the entire displayed batch; do not invent selective commit behavior.

Import receipts are credential-bound. Drain in-flight work before token renewal and test lost responses. A new token does not automatically own old jobs.

Use the actual service account for folder/proxy/protected-storage tests. Logged-in-user access is not sufficient. Remote revocation cannot be learned instantly while the host is offline; follow the bounded offline policy.

Do not call a live process or empty folder scan proof of current ERP data. Show service online, folder scan, last export and completed import independently.

## Stop conditions
For the same external failure, allow at most two retries after a diagnosis or changed condition. Then record the exact blocker and affected gate, continue independent work and consolidate the required owner action. Never loop on a missing secret or refactor to bypass permissions.

Run narrow tests during iteration and the required affected regression/release checks on the exact candidate. Do not weaken tests, authorization, signatures, historical migrations or retention safeguards. Do not repair unrelated products merely because their baseline CI is already failing.

Stop adding features when the named work-package acceptance criteria are met. Deferred scope is not required for completion.

## Final handoff
Report commits; artifact names/hashes; exact test outcomes including failures/skips; installed/deployed versions; supported source/version; G0–G4 status; remaining external prerequisites; and intentionally deferred work. A source merge is not deployment, and a fixture is not customer acceptance.
