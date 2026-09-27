# PackProof Desktop implementation and release status

Status recorded September 27, 2026. This is an implementation candidate with
automated verification and development installer builds. **The production
definition of done in the attached plan is not yet satisfied.** Signed public
distribution, live service acceptance and the physical hardware matrix remain
release gates.

Later deployment and acceptance evidence is recorded separately with its exact source commit and timestamps.

This report maps the numbered sections of
`PackProof_Desktop_Windows_macOS_Development_Plan(1).docx` to the implemented
work. “Implemented” means the code or workflow exists. It does not imply that an
external service, certificate, operating-system behavior or physical device has
been verified. The acceptance template remains pending until evidence is recorded
for the exact release commit.

## Verification recorded so far

| Evidence | Recorded result | What it establishes and does not establish |
|---|---|---|
| Desktop automated suite | 44 tests passed, including the added Orders filtering test | Auth/API contracts, encrypted queue failure/recovery behavior, renderer contracts, security helpers and sanitized reporting; not physical camera or OS acceptance. |
| Renderer smoke | 15 checks passed | Actual Chromium MediaRecorder with a synthetic webcam, original WebM chunks, locally bundled WASM EAN recognition, navigation guard, label confirmation, attestation, timestamps, major screens, dark mode and 1000-pixel layout. Backend/native bridge responses are test fixtures. |
| Backend regression selection | 51 tests passed | Desktop registration and multipart/commit/manifest contracts, account/allowance boundaries, shipping review, compatible existing capture behavior and media verification. Not a live deployed-service acceptance run. |
| Release policy and distribution suites | 10 tests passed | Signing/configuration prerequisites, channel separation and promotion validation. Not proof of a real signature or updater installation. |
| Migration operator | 19 tests passed | Exact inventory/SQL pins, read-only inspection, credential isolation, existing PostgreSQL privileges, trigger immutability and bounded operator transport; not a deployed migration receipt. |
| Update-host infrastructure | CloudFormation validation, four Guard rules and IAM policy validation passed | Additive private-bucket/CDN and isolated publication roles prepared; pending ACM certificate and exact external DNS record are documented in [the distribution runbook](../../infra/desktop-distribution/README.md). |
| Typecheck/build | Passed for tested local candidates | Source compiles and frontend/native bundles build. Final artifacts must be rebuilt from the final source commit. |
| macOS development CI | Apple Silicon and Intel builds passed in [run 36318867124](https://github.com/thepackproof/packproof-v2/actions/runs/36318867124), source head `d45727b` / PR merge `a379a2082dd21d92612caab4f5fbbcc9bca8739e` | Development packaging on native runners. Both packaged applications started with renderer/preload readiness and OS secure storage available. Ad-hoc signatures are not Developer ID signatures or notarization. |
| Windows development CI | Passed in the same run | Packaged native startup with OS secure storage available; silent current-user install, same-version reinstall and uninstall all preserved the queue sentinel. This is not real recorded-evidence recovery or production signing. |
| Packaged native launch check | Passed on all three native runners | Packaged main-process startup and renderer IPC through sandboxed preload; OS secure storage available. Authentication and physical capture remain separate checks. |

The checkout has been reconciled with the verified live backend source baseline
(`2328447`); reconciliation is recorded in commit `d45727b`. Test results and
earlier CI builds are not interchangeable with final-commit artifact acceptance.
Use the final CI artifact inventories, checksums, native-launch reports and
installer reports as the distribution record.

## Plan coverage

| Plan sections | Implemented work | Remaining verification or limitation |
|---|---|---|
| 1–3: dedicated desktop product and framework | Local Electron/React/TypeScript/Vite workstation with native services; no remote website wrapper. Windows and two Mac architecture packaging targets. | Signed installable production releases and real workstation acceptance remain pending. |
| 4: shared code strategy | Reuses existing PackProof API/domain types, presentation rules and barcode-related code. Native concerns are isolated under desktop main-process modules. | The illustrative monorepo folder tree was not imposed as a separate rewrite; future shared-package extraction should preserve compatibility. |
| 5, 52: Electron security | Sandboxed renderer, context isolation, Node disabled, local origin/CSP, narrow schema-validated IPC, main-frame sender checks, navigation restrictions, external URL allowlist, account/epoch fences and package hardening. | Verify the final signed packages and perform platform security acceptance; automated boundary checks are not a certification. |
| 6: authentication | Existing Cognito flow, registration/verification/reset, refresh, sign-out and native protected credentials. Tokens remain out of renderer storage. | Real account verification/reset delivery, refresh, Keychain/DPAPI behavior and two-account isolation on installed Windows/Mac builds. |
| 7–8, 24–25: navigation, dashboard and Proofs | Sidebar, attention/recent/fulfillment views, filtered and paged tables, detail/timeline/tracking/participants, original evidence playback, sharing, package export and server-controlled finalization. | Live data/permissions parity and large-account performance. Cached information is not authoritative server state. |
| 9–13: Packing Station and cameras | Device enumeration and preferences, preview, optional audio, resolution/fps, continuous bounded recording, timer, explicit finish/review, navigation guard, device-loss interruption and local barcode fallback. | Physical integrated/USB cameras, occupied/denied/re-enabled permissions, unplugging, label readability and every required barcode format on both OS families. |
| 10, 26–28: orders and tracking | Existing canonical fulfillment queue and backend integrations, marketplace/status/date/search filters, joined tracking search, order resolution/sync, label matching and explicit conflict handling. | Connected Shopify/eBay merchant walkthrough and real Shippo/carrier linkage in the deployed environment. Desktop creates no alternative marketplace identity system. |
| 14, 17: evidence metadata and integrity | Streaming SHA-256 over preserved originals; capture/device/version/detection context; server verification and committed manifest references. | End-to-end verification with actual installed camera recordings against the deployed backend. |
| 15–16, 18: local staging | Controlled app-data directories; encrypted per-account chunks and durable authenticated journals as the persistent database equivalent; OS-protected installation key; atomic/fsynced writes and missing-key protection. | Abrupt machine restart/power loss, full disk, antivirus interference and platform filesystem behavior with real pending evidence. |
| 19–20: resumable background upload | Stable upload identities, bounded parts, server part reconciliation, retry/backoff, exact hash/size receipts and separate upload/commit states. Recording can return to the next shipment while uploads continue. | Deployed large-file transport, network changes/loss at 5% and 95%, authorization expiry and sustained throughput. |
| 21–23: close, crash recovery and cleanup | Background tray/menu behavior, explicit quit choices, persistent job recovery, interrupted-recording retention and configurable verified-completion retention (24-hour default). | Installed-process crash/reboot/relaunch and earlier-version upgrade with actual queued media. Partial recordings are retained but never silently submitted as completed continuous captures. |
| 29: attestation | Explicit account-authenticated seller statement; no invented desktop biometric claim. Server requires appropriate evidence/attestation/review before finalization. | Full live seller walkthrough and confirmation that the deployed server enforces the same contract. |
| 30: native notifications | Local evidence completion/failure, connection restoration, marketplace synchronization and update-ready notifications, in-app workstation notifications and notification preference. | Native delivery/permission behavior and server-side attention notification coverage have not been certified. |
| 31, 47–48: deep links, scanners, shortcuts | Validated environment-specific protocols, Proof/order/upload navigation, keyboard-emulating scanner input and suffix settings, search/new-Proof/settings/capture shortcuts. | OS protocol registration/cold-start behavior and physical USB/Bluetooth scanner acceptance. Native HID/serial integration is outside V1. |
| 32–35: settings, diagnostics and reporting | Workstation/retention/theme/notification/update settings, version, redacted diagnostics, rotated coded logs and optional strictly filtered Sentry reporting. | A PackProof-owned reporting destination must be configured and receipt/filtering verified; no production telemetry delivery is claimed. |
| 36–40: Windows/macOS distribution | NSIS EXE; Mac APP/DMG/ZIP and optional PKG; per-environment metadata/protocols; queue-preserving install policy; signing, entitlements, notarization and verification automation. | Windows signing credentials/publisher identity; Apple Developer ID Application/Installer credentials and notarization; clean-machine signed installation and real upgrade/uninstall acceptance. |
| 41–42, 58–60: updates, environments and release pipeline | Distinct dev/staging/production identities and feeds, guarded updater, durable shutdown, no update restart during capture, version metadata, native CI matrix and protected promotion workflow. | PackProof update-host deployment/configuration and a genuine signed older-to-newer update with queued evidence. Production publication remains blocked without valid signatures and exact-commit acceptance. |
| 43–44: API authority | Existing typed domain contracts and backend lifecycle remain authoritative; stable capture/upload identities, request IDs, cancellation and token refresh. | Live backend candidate deployment and capability verification are pending at this snapshot. |
| 45–46, 55–56: offline/account behavior | Account-bound cached reads and local capture, protected staging, automatic retry, honest local-versus-remote status, account-switch fences and recovery isolation. | Installed/live-service offline capture, reconnection, revoked permission, expired sessions and machine restart. Offline recording does not guarantee future allowance or permission. |
| 49–51, 54, 57: accessibility/performance/testing | Keyboard/focus/labels/reduced-motion support, paging, bounded media/IPC processing, stream cleanup and automated failure tests. | Screen-reader use, OS scaling, 125–200% DPI, 4K/multiple monitors, resource soak, large queues and full Windows/Intel/Apple-Silicon hardware matrix. |
| 53: privacy | Minimal capture permissions, encrypted staging, no secrets/media in automatic reporting and documented retention/reporting behavior. | Review the current public privacy disclosures against shipped desktop behavior and configured telemetry before production. |
| 61–64, 66–68: phases, non-negotiables and definition of done | Foundation, Proof management, Packing Station, evidence engine, marketplace client, native features and distribution automation are implemented. Neutral positioning, server authority, canonical transaction identity and original preservation remain intact. | Release/hardening phases are not complete until signing, deployment and the acceptance matrix pass. The seller-on-a-clean-PC-or-Mac definition of done has not yet been demonstrated end to end. |
| 65: future enhancements | Architecture leaves room for additional workstation integrations. | Multi-camera synchronization, scales, native warehouse scanners, printer events, enterprise provisioning and expanded receiving/claims modes remain deferred as the plan permits. |

## Important contract decisions

- Offline desktop recordings use **post-capture registration** with
  `DESKTOP_CAMERA`, `CLIENT_REPORTED_DESKTOP_CAPTURE` and
  `POST_CAPTURE_CLIENT_REPORTED` provenance. Client timestamps never become a
  server start-time attestation. Acceptance still checks current permissions,
  billing allowance, original bytes and canonical Proof state.
- Migration `074_desktop_capture_registration` is additive to the reconciled
  backend. Clients require the advertised desktop capability before submission;
  an incompatible backend leaves the original on the workstation. Deployment is
  being prepared following recovered AWS access; successful activation is not
  recorded here yet. See [the backend contract](../../docs/DESKTOP_CAPTURE_CONTRACT.md).
- Existing server limits remain **300 seconds and 250,000,000 bytes**, with
  possibly lower account allowances. The implementation does not promise
  unlimited offline videos. WebM without a duration header is validated from
  bounded encoded packet timing without rewriting the original.
- Local journals are encrypted durable filesystem records rather than SQLite.
  The plan allows an equivalent persistent store; tested recovery and ownership
  constraints are the relevant guarantees.
- Development artifacts are explicitly labeled and separate from production.
  Mac ad-hoc signing is a development runtime requirement, not verified publisher
  identity. A successful CI build is not permission to label a package production
  ready.

## Remaining release gates

1. **Keep candidate automation current.** All three native platforms and the
   corrected Windows installer check passed run 36318867124. Subsequent source
   changes require the same checks on their final artifact commit; retain the
   checksums and reports.
2. **Activate the backend contract safely.** Verify the reconciled source/schema,
   apply migration 074, deploy the backend candidate, verify capability/health
   and complete a controlled real evidence upload/commit/finalize. Existing live
   functionality must remain intact.
3. **Configure production distribution credentials and hosting.** Supply the
   actual Windows publisher certificate/service, Apple Developer ID identities
   and notarization access, protected CI settings, and the PackProof update
   distribution endpoint. Build and verify signed candidates.
4. **Exercise installed-app acceptance.** Use clean Windows, Intel Mac and Apple
   Silicon machines with real cameras/scanners and real pending jobs. Complete
   the failure, permissions, account, marketplace, accessibility, signed-update,
   upgrade and extended-soak matrix in [RELEASING.md](RELEASING.md).
5. **Close operational checks.** Review privacy disclosures; configure and verify
   coded error-report delivery if enabled; record the exact-commit acceptance
   evidence before public promotion.

Until those gates pass, the accurate delivery description is **implemented and
automatically tested desktop candidate, with development installers and release
automation**. It is not a completed signed production launch.
