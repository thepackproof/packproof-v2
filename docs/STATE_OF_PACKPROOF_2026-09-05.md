# State of PackProof

Repository audit and remediation report | September 5, 2026 | Prepared for Collin, PackProof

## 1. Executive assessment

**PackProof is a substantial, working evidence platform in release-candidate validation. The repository supports a focused seller pilot, but the evidence available does not yet justify calling the entire product production-ready.** Its strongest asset is one shared, transaction-bound Proof model across Android, web, external APIs, and review/export. The main weaknesses were concentrated in recovery, integration authentication, sharing boundaries, and delivery automation. This audit repaired confirmed defects in those areas as they were found.

The product now extends well beyond the original two-user prototype: manual and imported orders, seller packing capture, durable upload recovery, buyer invitations, read-only sharing, shipment observations, custody workflows, receipt/return stages, a versioned partner API, outbound events, and portable evidence packages are represented in code. These are implementations, not proof that every provider or device scenario has been exercised live.

The recommended next move is **release validation and one complete seller-to-reviewer walkthrough**, followed by a tightly controlled cohort. Another broad feature expansion would dilute attention from the remaining reliability and usability gates.

The audit started from GitHub `main` at `ec47b5c7631b7589f0deb5ae2b9f7066fa01cd49`, including the comprehensive plan merge `902bb99`. The default branch was verified directly through GitHub. The baseline contained 244 backend, 78 web, 87 mobile, 9 infrastructure, and 20 documentation files; approximately 69,000 lines across code and tests; 26 SQL migrations; and 35 documented OpenAPI operations. These counts describe breadth, not quality.

**Delivery status:** The fixes are recorded on `codex/repository-audit-2026-09-05`. Publication and final validation are recorded below. Repository fixes, running AWS code, web assets, and installed Android builds must be treated as separate release states.

Source: [Baseline repository](https://github.com/thepackproof/packproof-v2/tree/ec47b5c7631b7589f0deb5ae2b9f7066fa01cd49), [comprehensive plan execution](https://github.com/thepackproof/packproof-v2/blob/ec47b5c7631b7589f0deb5ae2b9f7066fa01cd49/docs/COMPREHENSIVE_PLAN_EXECUTION.md).

## 2. Product capability and maturity

| Capability | Repository state after repairs | Readiness limit |
|---|---|---|
| Core Proof | One Proof per transaction; server-owned transitions; immutable finalized manifest | Historical digest parity during deployment still needs release verification |
| Seller workflow | Manual creation, confirmed paste intake, capture, review/retake, commit, attestation, finalize | Physical first-use timing and media readability remain unmeasured here |
| Android | Light/dark theme, video playback, durable recording recovery, native share intake, system Back handling | Signed candidate installation and device interruption tests required |
| Web | Full first-party workflow, responsive presentation, guest views, persistent capture queue | No rendered browser accessibility or camera QA claimed by this audit |
| Packing Station | Order resolution, capture, rescan/completion, recovery after lost responses | Real scanner/camera and extended station sessions need measurement |
| Invitations and sharing | User search, account invitations, scoped/expiring/revocable links, sharing drafts and tracker email machinery | Actual recipient delivery and external share targets need validation |
| Claims/reviewer surface | Detailed evidence record, chronology, playback, integrity data, access history, export | This is a review surface, not a claims-management or adjudication product |
| Receipt and returns | Targeted receiver authorization and separately sealed, linked stage manifests | Full two-device return journey remains a live gate |
| Custody/grading | Assets, capture recipes, observations, handoffs, participant continuity findings | Secondary workflow; corrected evidence requirements need device walkthrough |
| Partner API | `/v1`, scoped hashed keys, tenant bindings, rate limits, idempotency, audit records | Live partner onboarding and environment/key isolation not proven by local tests |
| Webhooks | Transactional event outbox, encrypted secrets, delivery leases, retries and replay | Real HTTPS receiver success/failure/recovery must be demonstrated |
| Order providers | eBay and Shopify OAuth/import adapters; demo storefront | Credentials, approvals and realistic account behavior remain provider gates |
| Shipping | Append-only observations, chronology and root-linked integrity supplement; EasyPost adapter | EasyPost is documented for test/staging; broad direct carrier coverage is absent |
| Portable evidence | `.pkpr` ZIP with frozen manifest, media, lifecycle supplements and Python verifier | External root digest needed for stronger verification; signing/timestamping unconfigured |
| Retention | 90-day policy calculations, holds, release authority and deletion-review requests | Physical deletion and backup treatment remain separate operational work |

Google and Meta connected accounts are identity connections in this repository. They do not implement buyer purchase imports or a Facebook Marketplace order API. Email-like text can be normalized; a production email-forwarding inbox has not been established by that parser.

## 3. Architecture and evidence meaning

The modular monolith is a sensible fit for PackProof's present stage. PostgreSQL owns canonical identities, participation, evidence records, manifests, integration bindings and durable work. Object storage owns the media bytes. Cognito maps verified external subjects onto internal PackProof user IDs. Android, web and partner APIs issue commands against the same domain instead of owning competing versions of Proof state.

| Boundary | Responsibility | Main repository evidence |
|---|---|---|
| First-party API | User authentication, participant commands, public projections | `backend/src/app.ts`, `server-app.ts`, `auth/` |
| Partner boundary | Tenant/key/scopes, request idempotency, rate budgets and events | `backend/src/platform/` |
| Evidence core | Upload ownership, digest verification, immutable commit and finalization | `domain/evidence.ts`, `finalize.ts`, migrations 018-020 |
| Media transport | Staging uploads and server-only committed objects | `backend/src/s3/` |
| Later observations | Shipment supplements and separately sealed commerce stages | `shipment-integrity.ts`, `commerce-lifecycle.ts` |
| External adapters | Translate provider data while preserving provenance | `backend/src/integrations/` |

The normal seller lifecycle is `READY_FOR_EVIDENCE → EVIDENCE_COMMITTED → FINALIZED`. Buyer participation is optional on the ordinary seller path. Explicitly required-counterparty workflows retain their separate participation checks. This keeps seller recording from depending on a buyer accepting an invitation.

A useful existing control is the separation between client-writable staging objects and server-owned committed media. Old upload URLs cannot overwrite the bytes referenced by a committed record. Database guards reject mutation/deletion of committed evidence, and finalization freezes canonical JSON and its SHA-256 digest. Later shipment data and receipt/return manifests supplement the root rather than reopen it.

**The defensible claim is precise:** PackProof ties preserved bytes and attributed assertions to a transaction and exposes integrity checks. A matching hash does not independently prove the physical scene, honest authorship, correct contents, uninterrupted custody, or an externally trusted capture time. Signatures and trusted timestamps are explicitly unconfigured. The audit corrected an automatic custody result that crossed this boundary by treating matching capture slots as visual consistency.

The current module count does not justify a microservice rewrite. A more useful next architectural investment is measured media capacity, reliable release automation and validated PostgreSQL concurrency. The code still buffers large media operations; the documented 1 GiB pilot allocation is a capacity assumption to test, not a scale guarantee.

## 4. Corrected evidence, security and integration defects

Severity reflects the plausible effect of the defect. It does not claim exploitation occurred. The following are confirmed code defects and implemented repairs.

| Finding | Impact | Repair |
|---|---|---|
| High: pending upload replay lacked ownership and request consistency checks | A grading participant could collide with another participant's upload key and obtain a writable target; changed MIME/purpose could reuse an old request | Require original submitter and identical evidence metadata on replay and race-recovery paths |
| High: grading could finalize without documented evidence | Packing and handoff commands alone could satisfy finalization | Require committed origin coverage for every asset and the stored capture recipe's required slots |
| High: unsupported automatic consistency result | Slot availability could be presented as evidence that content matched | Automatic checks now report availability/inconclusive status; manual findings are attributed and use server-owned provenance identities |
| Medium: grading return-packing was inaccessible | Receivers could create a return-packing observation but could not upload its prescribed evidence | Permit both grading roles to upload packing captures while preserving commerce seller-only permissions |
| Medium: core evidence accepted empty or oversized committed objects | Empty media could count as evidence; direct path differed from bounded resumable/stage limits | Enforce nonempty media and a 200 MiB commit limit |
| High: Shopify callback lacked complete authenticity and shop binding | Unsigned/tampered callbacks or substituted shop input could cross the OAuth trust boundary | Verify callback HMAC and bind callback shop to the stored OAuth attempt |
| Medium: Shopify imports stopped at the first page and used an obsolete API pin | Orders beyond the first 50 were silently omitted | Use the supported 2026-07 REST version, validate same-shop cursors, persist progress, and process bounded pages with retry continuation |
| Medium: real Shopify order IDs were discarded | Numeric IDs in real provider responses failed a string-only parser, producing empty import results | Normalize safe numeric IDs to strings; test realistic provider payloads |
| Medium: intercepted email routes bypassed CORS | Browser requests could pass preflight but fail on the actual response | Apply a shared HTTP boundary before all production routers, including safe parser errors and response headers |
| Medium: notification dispatch lacked claims | Concurrent maintenance could send the same queued notification multiple times | Add expiring claims, stale-worker protection, bounded retries, link/preference rechecks and maintenance coalescing |
| High: status-only tracker content exceeded intended scope | A restricted tracker or email could reveal item/shipment detail | Apply scope-aware redaction consistently and correct packing/outbound-delivery milestone meaning |
| Medium: SMTP failure handling was incomplete | Socket failures or hanging conversations could strand dispatch work | Bound the conversation and preserve safe retry behavior without storing provider secrets/error bodies |
| Medium: access accounting was non-atomic | Concurrent views could duplicate first-access bookkeeping; stale rate entries could accumulate | Lock/update access accounting transactionally and bound rate-map cleanup |
| High: partner link replay cached a bearer token in plaintext | The idempotency table retained a usable sharing credential | Encrypt sensitive access-link replay responses using the configured encryption key and fail closed when unavailable |

Core file evidence: `backend/src/domain/{evidence,finalize-requirements,finalize,continuity,proof-notifications,proof-tracker,access-links}.ts`, `backend/src/integrations/connected-accounts/providers/shopify.ts`, `backend/src/integrations/shopify/{hmac,client}.ts`, `backend/src/http/boundary.ts`, and `backend/src/platform/router.ts`.

Stored observations and already-finalized manifests remain unchanged. Live projections conservatively show legacy default `visual-slot-completeness/v1` `CONSISTENT` results as `INCONCLUSIVE` and label them as capture-availability checks. Newly finalized grading manifests use that clarified projection. The existing commerce seller path and optional-counterparty policy remain regression gates.

## 5. Corrected client and recovery defects

| Finding | User consequence | Repair |
|---|---|---|
| High: signed-out web API origin was empty | Shared links on CloudFront queried the frontend host instead of the API | Use the configured API origin without a session |
| High: sign-in discarded invitation/receipt destinations | A recipient signed in and landed home without completing the intended action | Preserve supported pending destinations through authentication |
| High: Packing Station rejected already-committed recovery | A lost commit, attestation or finalize response stranded an otherwise successful recording | Persist exact evidence identity and resume from authoritative server state |
| High: station browser recording existed only in memory | Reload or expired sign-in destroyed the user's retry path | Store station media and recovery metadata in IndexedDB, scoped to the account |
| High: Android authentication loss cleared recovery data | An expired session could strand a locally preserved recording across restart | Persist a reauthentication state and restore capture metadata only for the matching account |
| High: refresh/read responses could outlive their account or route | Old responses could overwrite newer capture state, sign out a newer screen, or restore an obsolete session | Guard response ownership and coalesce Cognito refresh work |
| Medium: Android's default role filter hid invitations | The default All view did not show pending invites | Share correct invitation filtering semantics across clients |
| Medium: Android system Back had no app handling | Back could leave the app instead of navigating or guarding an active station/capture | Add route-aware Back handling and capture/station guards |
| Medium: request bodies and transports lacked complete deadlines | An action could appear stuck indefinitely and leave recovery ambiguous | Bound JSON/account/media/upload operations while preserving explicit retry state |
| Medium: forbidden actions were treated like expired login | Ordinary permission errors forced unnecessary sign-in | Keep authorization failures distinct from authentication expiry |
| Medium: public viewer mishandled revocation versus outages | Stale content could remain after access loss, or a temporary outage could look like permanent revocation | Clear definitive access failures; retain explicitly stale data during outages; bound polling and provide retry |
| Medium: receipt/station control races | Duplicate taps, unresolved stage state and leave/retry transitions could trigger conflicting actions | Resolve the stage before capture and guard in-flight station actions |

The repairs build on the existing light/dark design and evidence-first layout. They improve completion and confidence more than another cosmetic pass would. The review did not certify visual polish through a rendered browser or signed Android installation. Camera autofocus, exposure, sound, aspect ratio, safe-area behavior, motion and screen-reader operation still need inspection on the actual release candidate.

Important device targets for that pass are the Galaxy S24 Ultra and Galaxy A16 5G, which cover a useful high-end/budget contrast for PackProof. Test both gesture and three-button navigation. A successful TypeScript build does not establish that a recording is readable or that Android preserves it under real process death.

## 6. Delivery and repository health

The baseline GitHub run for `ec47b5c` passed CI, CodeQL and the foundation infrastructure checks. Its staging deployment workflow failed at the ECS stability waiter. Read-only AWS inspection showed the service completed the rollout about a minute after the waiter exhausted its attempts. The observed evidence supports a pipeline timeout, not a demonstrated backend crash. At the read-only check, the API health endpoint returned 200 and `/meta` reported `ec47b5c`, but the web still served the September 1 asset `index-nwj-CUNM.js`. The web release manifest was absent. This is a confirmed API/web release gap, consistent with the pipeline stopping before web deployment.

The deployment scripts created an initial rollout with incomplete optional settings, followed by a restoration rollout; the web deployment could trigger another CORS rollout. This unnecessarily lengthened release time and risked temporary configuration loss. The audit consolidates prior runtime settings and explicit overrides into the initial desired configuration, avoids redundant updates, and uses a bounded status-aware wait with useful failure diagnostics.

| Delivery defect | Implemented correction |
|---|---|
| Deployment could race ahead of the commit's CI result | Require successful CI for the exact target SHA before cloud changes |
| Web parity check looked for old UI phrases | Generate and verify a release manifest tied to the commit, index and asset digests |
| Generic waiter obscured slow versus failed rollout | Check service/image convergence and rollout state, with bounded waiting and selected diagnostics |
| Multiple startup tasks could apply a migration concurrently | Serialize bootstrap and each applied-check/DDL transaction with a PostgreSQL advisory lock |
| Handoff and finalize acquired shared rows in different order | Align lock ordering to remove the inspected deadlock path |
| PostgreSQL concurrency was not exercised by the default suite | Add a disposable PostgreSQL CI service and isolated-schema concurrent migration tests |
| README described old clients and omitted shared test dependencies | Update current capabilities and fresh-checkout setup instructions |

Migration `027_notification_delivery_leases.sql` is additive. Keep its columns during rollback. The delivery guarantee applies once every dispatcher runs the new claim logic; older workers do not honor those leases. SMTP remains at-least-once because a crash can occur after provider acceptance and before recording success.

At audit start, 21 pull requests were open: 20 automated dependency proposals and the earlier product-hardening PR #26. That earlier PR had not reached `main`. Relevant fixes were checked and ported individually against current code; its obsolete package/export shape was not blindly restored. Broad Expo, React Native, Express or tooling major updates should not be bulk-merged simply because a subset of checks passes.

Live infrastructure inspection was read-only. This audit did not deploy its candidate or submit an Android build. Matching the repaired API, web and mobile versions remains necessary before claiming the fixes are live.

Source: [Baseline CI](https://github.com/thepackproof/packproof-v2/actions/runs/33946286405), [deployment failure](https://github.com/thepackproof/packproof-v2/actions/runs/33946286407), [unmerged hardening PR](https://github.com/thepackproof/packproof-v2/pull/26), [PostgreSQL advisory-lock semantics](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).

## 7. Validation and assurance

The audit traces actual commands and failure paths and adds regressions for reproduced defects. It does not infer production readiness from the number of tests.

| Check | Result |
|---|---|
| Complete backend suite | 335 passed; 6 skipped across 57 test files |
| Complete web suite | 77 passed across 10 test files |
| Backend | TypeScript check and production build passed |
| Web | TypeScript check and Vite production build passed |
| Mobile | TypeScript check passed; Android export and isolated prebuild passed |
| Deployment scripts | Native PowerShell parsing and behavioral regressions passed |
| Dependency reproducibility | Clean mobile installation and dependency tree check passed |
| Diff hygiene | `git diff --check` passed |
| Live baseline | API health and exact baseline SHA verified; web mismatch confirmed |
| Candidate GitHub gates | Read the candidate checks for CI, CodeQL, infrastructure and real PostgreSQL migration results |

The six skipped backend tests comprise five opt-in live-service cases and the PostgreSQL case that needs its dedicated CI database. There were no failed local tests in the final integrated run. Mobile-focused tests run within the backend suite; they should not be added again to inflate the total. Across the final local backend and web suites, **412 tests passed**.

The main automated suite uses PGlite and controlled object stores/provider transports. It provides strong feedback on domain rules, byte integrity, authorization, deterministic manifests, imports, retries and client state. It does not reproduce the full production database topology, device OS lifecycle or external services. The new dedicated PostgreSQL job specifically strengthens migration concurrency evidence; it is not a full database load or failover exercise.

New regression coverage includes upload ownership/metadata replay, empty-media rejection, grading evidence bypasses, automatic/manual continuity provenance, Shopify callback authentication and numeric order IDs, CORS on intercepted routes, notification claims/retries, sharing redaction, sensitive idempotency response encryption, migration concurrency/rollback, station response-loss recovery, authentication/capture races, guest API origins, deep links, and invitation filtering.

Package verification remains independently reproducible with `backend/scripts/verify-proof-package.py`. A successful verifier result establishes consistency relative to the supplied digest. Obtain the expected root digest separately; a self-contained archive and its own self-declared hash cannot independently establish origin.

No penetration-test, security certification, formal compliance, large-scale performance, disaster recovery, real delivery success or physical device result is claimed by this report. A limited tracked-file scan found no common AWS-key, GitHub-token or private-key patterns; that is not a full history/secret-scanner audit.

## 8. Security, privacy and unresolved configuration

| Project | Audit before | Audit after compatible remediation |
|---|---|---|
| Backend | 3 moderate | 0 |
| Web | 0 | 0 |
| Mobile | 23: 11 moderate, 11 high, 1 critical | 10: 9 high, 1 critical |

These are dependency entries, including affected ancestor packages, not independently demonstrated application exploits. The backend uses a scoped `qs` override to 6.16.0. Mobile overrides update Expo plist's XML parser, Metro's PostCSS and selected tooling UUID consumers. Clean installation, Android export and isolated Android prebuild passed while retaining Expo SDK 52 and React Native 0.76.

The unresolved families are `tar` 6.2.1 through Expo CLI/cacache and `image-size` through Metro. Patched tar 7 was tested and found incompatible with Expo 52's compiled import expectations; the experimental override was removed. The reviewed image-size advisory provides no patched release. These are known remaining issues, not fixed findings. See the [qs maintainer advisory](https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g), [tar maintainer advisory](https://github.com/isaacs/node-tar/security/advisories/GHSA-23hp-3jrh-7fpw) and [image-size advisory](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr).

The audit deliberately avoids substituting dependency counts for exploitability. Build-time archive/XML/image parsers and development servers have a different exposure from code running in the shipped Android client. They still matter to a secure release process. The remaining Expo/Metro findings need a coordinated supported SDK/toolchain migration with a rebuilt and installed candidate, rather than isolated incompatible major bumps.

The repository has useful controls: internal identity mapping, participant and tenant authorization, hashed API keys, scoped public links, encrypted webhook secrets, server-side media hashing, immutable database guards and append-only audits. These controls require correct deployment configuration. Partner access-link replay encryption and outbound webhook signing require the configured encryption key. This is documented and fails closed; it does not turn an unconfigured environment into a working partner integration.

Several remaining items are configuration or operating decisions that cannot honestly be completed by changing a code constant:

- Legal pages still contain developer-review fields for the legal entity, privacy/support contact, mailing address and governing-law/venue language. This report flags the missing inputs; it does not invent approved legal terms.
- Automatic physical deletion is absent by design. Holds and deletion requests are meaningful controls, but are not a completed deletion service. Backup and Object Lock treatment need an authorized operating procedure.
- Manifest signing and trusted timestamping are unconfigured. Avoid language suggesting that SHA-256 alone provides either property.
- Production foundation templates do not prove deployed backup restoration, alert routing, Object Lock enforcement or incident response. Those require observed checks in the intended account.
- OAuth adapters and ingestion endpoints do not prove marketplace approval, working merchant credentials, email ingress or live carrier coverage. Shopify pagination and the obsolete REST version pin were repaired; GraphQL modernization for distribution requirements remains separate work. Pagination was checked against [official Shopify documentation](https://shopify.dev/docs/api/admin-rest/usage/pagination).

Native session credentials still use AsyncStorage; migration to OS-keystore-backed credential storage is a further hardening consideration. No externally exploitable issue from that choice was demonstrated here. Historical plaintext partner link-cache rows are encrypted on authorized replay; untouched legacy rows require a controlled cleanup plan.

These items should remain visible in release decisions. They are not reasons to remove integrity controls or pretend an external gate was completed.

## 9. Recommended pilot and development sequence

**First: release one coherent candidate.** Review and land the audit branch after CI. Deploy its API and web through the repaired pipeline, verify exact release identities, and build/install the matching Android candidate. Recheck a historical finalized digest. Keep the previous image and additive schema rollback plan available.

**Second: run one full transaction and return.** Use one seller and one receiver on separate accounts/devices. Create/import the order, record/review/retake, interrupt upload, recover without retaking valid media, attest/finalize, share with a signed-out viewer, verify scope/revocation, export and independently verify the package. Then exercise receipt, return packing and seller receipt without changing the root manifest.

**Third: prove the external and operational edges.** Validate one realistic Shopify/eBay account, one trusted carrier test path, and one approved webhook receiver. Exercise provider disconnect, receiver failure/recovery and duplicate delivery. Verify backup restore and alert routing. Run concurrent large-media tests at the actual pilot load while recording peak RSS and latency.

**Fourth: use a small high-value seller cohort.** The existing runbook proposes 5-10 consenting sellers and roughly 30 shipments in collectibles, watches, comics or electronics. These are targets, not completed recruitment. Observe preparation time, first-Proof completion, recovery success, media readability, reviewer comprehension and voluntary repeat usage. The most useful product feedback is whether sellers can repeatedly finish and reviewers can quickly understand the record.

**Then prioritize based on observed failure.** Fix the highest-friction completion step before adding more connectors or dashboards. Upgrade the Android toolchain as a coordinated release. Stream large-media assembly or move it behind a bounded worker when measured capacity requires it. Add signing/trusted timestamps only when a concrete verifier or partner requirement warrants the operational responsibility.

Cost cannot be responsibly totaled from this repository alone. Main cost drivers are the always-on API/database footprint, evidence volume and retention, media playback/export egress, logs/backups and external provider usage. AI inference is not a prerequisite for the existing evidence workflows, and this audit found no reason to add adjudication merely to expand the feature list.

## 10. Final decision and evidence trail

**Recommended decision: continue toward a narrow, observed pilot; do not widen access on the basis of code completion alone.** PackProof has the central architecture and product surfaces to make the neutral evidence-infrastructure proposition concrete. This audit closes important code defects that could otherwise undermine that proposition during a first seller or reviewer encounter.

The remaining work is specific: coherent deployment, signed Android installation, physical interruption/media tests, real provider configuration, large-media capacity, restore/alert evidence, approved legal/contact inputs and a coordinated dependency upgrade. Broad connector proliferation, AI fraud decisions, a claims-management suite and a distributed-service rewrite would not resolve those gates.

All repaired source, regression tests, additive migration, deployment changes and this report are included on the [audit branch](https://github.com/thepackproof/packproof-v2/tree/codex/repository-audit-2026-09-05). The branch is based on `ec47b5c`; see its pull request for the immutable candidate commit and final GitHub checks. Changes have not been deployed by this audit. Local test logs and native tooling outputs support the verification summarized above.

Repository review anchors:

- `docs/DEVELOPMENT_PLAN.md`, `docs/architecture.md`: authoritative invariants and boundaries.
- `docs/COMPREHENSIVE_PLAN_EXECUTION.md`, `docs/PILOT_RUNBOOK.md`: implementation traceability and live gates.
- `docs/PUBLIC_API.md`, `backend/openapi.json`: partner contract and configuration.
- `backend/src/domain/`, `backend/src/platform/`, `backend/src/integrations/`: evidence, lifecycle and provider behavior.
- `backend/tests/`, `web/src/tests/`: automated assurance and regression evidence.
- `mobile/src/capture.ts`, `mobile/src/session-recovery.ts`, `mobile/src/packing-station/submit.ts`: recording and account recovery.
- `infra/deploy*.ps1`, `infra/deployment-helpers.ps1`, `.github/workflows/`: release mechanics and gates.

This is a source-based engineering assessment, supported by local validation, current GitHub workflow evidence and limited read-only AWS inspection. It is not a statement that all reachable branches, historical secrets, cloud resources, external accounts or physical devices were exhaustively audited.
