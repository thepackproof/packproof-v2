# PackProof Connect 0.5.0 implementation and acceptance

The candidate's Windows installer, service and renderer use the existing PackProof Connect channel identity. The backend compatibility boundary is migration 123. Verify the source commit, environment and installer checksum in the build-specific release evidence before running a pilot.

## Implementation map

| Part | Source and operating contract |
| --- | --- |
| Setup and daily use | `connect-windows/ui/WorkspaceApp.tsx` and `WorkspaceOrders.tsx` provide the resumable source screens, permissions, output destination and order review. The Electron main process invokes the installed native bridge. |
| Background service | `connect-windows/service/AgentRuntime.Workspace*.cs`, `WorkspaceCollector.cs` and `DurableQueue.Workspace.cs` manage approved source generations, event wakeups, reconciliation, per-source checkpoints and a persistent queue. |
| Interpretation | `connect-windows/service/SourceReaders*.cs` and `WorkspaceMapping.cs` retain input locations and bind versioned interpretations to an approved source. See the [format and vendor register](../connect-workspace-compatibility.md). |
| Approvals and transport | `backend/src/records/order-workspace.ts`, `order-api-history.ts` and `cloud-order.ts` scope grants, API events and historical snapshots to the operation. The browser returns to the exact installation and source request. |
| Canonical history | `backend/migrations/123_order_workspace.sql`, `order-ledger.ts`, `order-projection.ts`, `order-review.ts` and `order-feed.ts` implement the original receipt, normalized event, association history, immutable revision and ordered change feed. |
| Web and local copies | `web/src/records/OrderProofs.tsx` and `OrderReferenceReview.tsx` render and review committed orders. The service output writer publishes immutable revision packages and replaces the current pointer after verification. |
| Installer and release | `.github/workflows/connect-windows-ci.yml` builds and exercises the development installer. The signed channel uses `connect-windows-release.yml`. Backend image preparation and migration compatibility checks are in `infra/backend-release`. |
| Reproduction | The [controlled journey](../../examples/multisource-journey/README.md) includes fixture publication, verifier and expected business results. The [release notes](MULTISOURCE_RELEASE.md) record recovery instructions and measured observations. The [usability protocol](WORKSPACE_USABILITY.md) covers operator testing. |

## Acceptance evidence

An isolated check uses synthetic records and the actual implementation. A hosted Windows run qualifies only the installer, dependencies and Windows version identified by that run. A pilot requires its own authorized connection and representative records.

| ID | What was exercised | Evidence or remaining qualification |
| --- | --- | --- |
| A01 | Setup, reopen and dashboard in one application | Renderer and persistent draft tests. Refer to the build-specific packaged run for installation and shortcuts. |
| A02 | Repeated folder screens, accessible labels and Next | Renderer and packaged keyboard script. First-time operator observation remains open. |
| A03 | Separate folders, multiple roles and an approved API source | Native multi-source tests and authenticated API history fixture. A named ERP needs an entitled account. |
| A04 | A shared location supplies several stages | Source registry and collector tests check one subscription with distinct roles. |
| A05 | Initial order appears before downstream evidence | The controlled journey observes the initial SO10482 proof before publishing later reports. API history and live intake also exercise an upstream order. |
| A06 | Warehouse, package and tracking identifiers join the order | Order projection and HTTP journey fixtures. |
| A07 | Split shipments, consolidation and distinct lines with repeated SKUs | Backend variant fixtures and SO10482 output verifier. A consolidated shipment retains separate order roots. |
| A08 | Replay, partial and cumulative updates, old revisions and corrections | Ledger, HTTP and projection tests. The line 20 correction preserves already shipped quantity. |
| A09 | Evidence arrives before its linking reference | The original detached evidence joins the order after the package bridge arrives. |
| A10 | Tenant, operation and raw-original authorization | Backend intake security, original retrieval and database role tests. Mixed-order source reports are excluded from local originals. |
| A11 | Original bytes and historical interpretations remain available | Independent hashes, prior revision reads and explicit reviewed reassociation. Preexisting cloud records without original bytes carry a derived-history label. |
| A12 | File completion, revisions and mapping drift | Native collector, reader and workflow-profile cases cover supported publication patterns. Customer export completion conventions need a sample. |
| A13 | Snapshot, later events and recovery | Scoped history cursor and replay checks, worker reopening its queue and reconnect/reconciliation. Verify each provider's replay limits during onboarding. |
| A14 | Desktop and web report the same committed revision | The hosted Windows journey opens the built web portal in Chromium, checks the corrected order number, quantities and revision, and compares the service feed and verified local bundle. |
| A15 | Local and authorized cloud-origin orders reach output | The scoped API feed and mixed cloud/local order fixture exercise delivery to the designated writer. |
| A16 | Interrupted local output and recovery | Previous revision remains readable after destination loss. Once access returns, an independent verifier checks the latest pointer, manifest and original bytes. |
| A17 | Input/output overlap and duplicate writers | Windows path and writer-fencing tests. Actual customer UNC aliases and share permissions require a site check. |
| A18 | Browser consent resumes the selected installation | The hosted Windows journey clicks the rendered Approve collection control, observes the portal confirmation, then waits for the actual service to collect under that grant. It uses an authenticated synthetic browser session. A live Cognito sign-in and an independent human walkthrough remain open. |
| A19 | Empty, skipped, ambiguous and unsupported records | Preview and review cases exercise waiting states and explicit user decisions. First-time operator observation remains open. |
| A20 | Work continues independently of the dashboard | The native service runs the HTTP journey without a UI. The packaging workflow checks automatic startup and service restart. Physical Windows 11 reboot requires observation. |
| A21 | Upgrade retains identities, permissions and queued data | The hosted packaging workflow seeds a prior protected queue and checks LocalService upgrade and repair. Record the passing artifact identity before deployment. |
| A22 | Required readers and claimed versions | Per-format fixtures and the compatibility register distinguish recognized, interpreted and qualified scope. Named customer sources are individually pending. |
| A23 | Keyboard operation, accessible names and scaling | Packaged screenshot and keyboard checks cover the recorded zoom levels. Narrator and an independent human walkthrough remain open. |
| A24 | Saved evidence survives recovery | Isolated backend cold restore preserved 2 proof roots, 7 revisions, 6 originals and a prior association decision. Windows queue/retained-output restore ran under a test protector. A machine-bound restore and a live database recovery drill require separate evidence. |

For a release decision, inspect the exact build's workflow status, install smoke receipts, screenshots, revision hashes, backend deployment identity and configured web release. A candidate can pass its synthetic order journey before the corresponding hosted backend is available. Keep customer rollout scoped to the reviewed systems and location until those checks complete.
