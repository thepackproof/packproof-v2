# G1 surface and state coverage

All 12 required compositions are reachable through the external surface picker and product navigation. They share light/dark tokens and 100/130/200% text controls at 320/360/393/411 CSS px design widths. This is **coverage of a design simulation**, not evidence of Android layout, runtime state restoration, capability parity or test-suite completion.

## Required screen-state coverage

Choose a surface, then the **Screen state · design fixture** control (`#viewstate`). Values are `standard`, `empty`, `loading`, `error`, `offline`; the API is `Prototype.setViewState(mode)`. All modeled cells use the selected light/dark and text-size settings. `screen-state-matrix.json` exports the same applicability and exact copy as the prototype.

An applicable Empty selection **resets the synthetic data to a coherent empty fixture**; it is not a runtime operation on a saved Proof. The first in-phone action returns to Standard so the label and next action stay consistent. Loading, error and offline inspection preserve source/job metadata. Scenario reset and empty reset are external reviewer operations, clearly separate from the proposed product UI.

| Surface | Empty | Loading | Error / unavailable | Offline |
|---|---|---|---|---|
| Home | First-Proof prompt; one Create CTA | Task/catalog skeleton; no inferred next task | Specific load failure; retry and pending-upload access | Cached task notice; original recovery remains available; new capture requires reconnection |
| Proofs | No records; Create CTA; search empty results also supported | Catalog skeleton | Specific catalog failure with retry; protected local source unchanged | Cached catalog notice; recent changes may be absent |
| Capture | No linked orders; no empty search/filter; manual path visible | Server capture-options pending; no recording started | Capability lookup unavailable; retry before packing | Local saved captures remain available; new Proof/capture eligibility blocked until online |
| Camera | **N/A:** no remote empty dataset; ready/not-started is the valid initial state | Camera initialization with no recording started | Camera initialization failure; item retained; retry | New start blocked before recording; an already active continuous simulated take is not silently paused |
| Review | **N/A:** route requires a complete original; missing/incomplete take uses recovery | Local original opening; source retained | Unable to open original; retry viewing without demanding retake | Local review allowed; secure confirmation/submission waits for connection |
| Evidence | Packing original absent; exact allowed capture next action | Server evidence lookup pending; no finalization inferred | Evidence temporarily unavailable; local original unchanged | Saved details plus last confirmed status; no new server result invented |
| Shipment | Optional tracking collapsed; Add tracking opens form | Tracking association lookup pending | Tracking unavailable; evidence stage unchanged | Cached raw details; carrier updates unavailable; attempted save retains form and requests reconnection |
| History | No visible events; no fabricated creation/join event | Authorized event lookup pending | History temporarily unavailable, explicitly distinct from no activity | Cached event list, explicitly possibly missing recent events |
| Updates | No action alerts / FYI yet | Authorized updates pending | Notification refresh unavailable; saved Proof access retained | Cached alerts; new notifications may be delayed |
| Profile | **N/A:** local signed-in navigation, not an empty dataset | **N/A:** local menu available without fetching; destination owns remote data | **N/A:** menu itself has no remote read failure | Menu stays usable; no remote operation implied |
| Settings | **N/A:** local navigation groups are always present | **N/A:** local navigation shell; account/billing data belongs to destination | **N/A:** no synthetic menu-fetch failure; account-data failures belong to destination | Local preferences/help remain available; no remote mutation claimed |
| Integrations | Provider list with no connected account and manual bypass | Provider availability/connection lookup pending | Provider list unavailable with retry and manual bypass | Cached connection details; connection/refresh requires online; manual item entry remains reachable |

N/A is shown in the external inspector when that mode is selected. It does not create a fake empty camera, unavailable local Settings menu or signed-out Profile. Loading/error recover through an explicit simulated loaded response or retry. Loading/error/offline states preserve the selected actor and permissions. The external Scenario and applicable Empty controls deliberately select fresh synthetic assumptions, which may reset the fixture actor to seller; these are reviewer controls, not runtime permission changes.

## Integration authorization variants

These are distinct from provider-list fetch loading/error above. Select the matching scenario; it opens Integrations automatically.

| Scenario ID | Exact state | Interaction and truthful outcome |
|---|---|---|
| `integration-authorizing` | Waiting for Shopify authorization | No connected-account claim. Cancel connection → canceled. External Advance simulated event → simulated accepted authorization. |
| `integration-canceled` | Connection canceled. No selling account was connected. | Connect can start a new explicit simulated attempt; manual creation remains available. |
| `integration-error` | We couldn’t connect Shopify. | Try again opens the explicit simulation sheet; existing Proofs unchanged. |
| `integration-expired` | Shopify authorization expired. | Reconnect required for refresh; imported records retained. No silent connection success. |

Provider authorization never uses OAuth, requests credentials, makes network calls or changes an actual selling account. Expired provider authorization is **not** a simulation of expired PackProof authentication.

## Deterministic scenario picker

| ID | Initial fact | Permitted next step / truthful result |
|---|---|---|
| `fresh` | Authenticated eligible seller; no Proofs | New item → online preflight → continuous simulated take. |
| `resume` | Existing seller Proof, no packing original | Record packing after modeled preflight. |
| `offline` | Original and declaration already saved; upload queued | View pending upload; reconnect resumes original job. |
| `failed` | Same saved original/job; transfer failed | Retry same job; no re-recording. |
| `interrupted` | Upload interrupted after protected source save | Recovery uses original/job; separately acknowledged server receipt and finalize events. |
| `unknown-ack` | Upload sent; server acknowledgement unknown | Explicit reconcile returns received; does not retry upload or infer immediate finalization. |
| `finalized` | Fixture server has finalized | Evidence viewer and seller-only simulated share. |
| `waiting` | Authenticated buyer with view-only invitation | Wait for seller; no seller records or capture requirement. |
| `policy-blocked` | Modeled server capture allowance declined | Plan context; explicit simulated eligible response before recording. |
| `permission-denied` | Camera denied | Simulated device settings recovery; scan has manual fallback. |
| `no-storage` | Insufficient writable storage fixture | Manage-storage context; explicit simulated sufficient space before recording. |
| `signing-unavailable` | Secure device signing unavailable | Explain required signing before recording; route to signing help. |
| `history-empty` | Server supplied no visible history events | Show no activity; do not invent creation or participant events. |
| `history-unavailable` | History read unavailable | Distinguish failure from empty; retry leaves original/job intact. |
| `loading` | Proof fetch pending | Stable Home/Proofs skeleton; explicit loaded response. |
| `error` | Proof fetch failed | Specific retry; local source preservation copy; no endless spinner. |
| `orders` | One authorized linked-order fixture | Reuse item data; camera preflight without re-entry. |
| `capture-interrupted` | Partial take saved, not a valid continuous recording | Review partial take; repeat activity only when feasible. Cannot sign/submit partial take. |

## Known G1 deviations and unresolved design coverage

1. The first-time Home has one Create Proof action plus a quiet capture-options path; the separate outlined Create a new Proof action appears once an existing Proof is selected. This avoids duplicate create CTAs in the empty account view while preserving a direct start-new route for resumable users.
2. The 12 required surfaces now have explicit read-state coverage or reasoned N/A cells above. Account destination fetch/auth-expiry, conflicting-label review and additional recipe-specific photo capture are not represented by those generic states; they remain separate scenario decisions. They must not be marked tested or inferred from this matrix.
3. Waiting is represented by a buyer waiting for seller; the sample seller catalog additionally includes a seller waiting for buyer, which is excluded from needs-action filtering.
4. Optional receipt is a discoverable simulated preference. It is not a newly implemented receipt service.
5. Shared existing application routes, real `NextAction` adapters, all currently implemented authorized advanced capability behavior, iOS/web/desktop parity and deep links are for later gated production work. The prototype does not replace or remove any of them.
6. Recovery state is in memory and reset on page reload; scenario selection supplies deterministic post-relaunch fixtures. A real force-stop/relaunch outcome has not been tested.
7. The phone’s minimum touch boxes target 48 CSS px at design scale, not a verified native 48 dp. Font scaling uses CSS. Native TalkBack, gesture navigation, safe insets, keyboards and physical device viewports remain unverified.
8. Automatic simulated server events are for review convenience. Disable them for exact snapshots. Every success event is explicitly a fixture, never evidence of network confirmation.

This document is an honest G1 submission boundary, not a claim that all A01–A15 / B01–B15 acceptance cases pass.
