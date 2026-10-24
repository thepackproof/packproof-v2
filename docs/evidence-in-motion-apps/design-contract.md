# Evidence in Motion — Design handoff draft

Snapshot: October 24, 2026. This draft records the current design ledger, not implementation or release acceptance.

## Design identity and evidence

- File: [PackProof SIGNAL + Evidence in Motion](https://www.figma.com/design/4AtxdZJxHvpWVF3cCX14Z0?node-id=22-1921).
- New page: `22:1921` — `EVIDENCE IN MOTION · App contract v1`.
- Historical SIGNAL page: `0:1`, preserved. Historical nodes below remain the behavioral migration references.
- Work session: `4b184b79-4e4e-4ae2-b858-6fc1bd3c93a2`.
- Named contract revision: **EIM v1, 2026-10-24**. Ledger checkpoint: `support-station-themes-variants-large-text`; run `eim-2026-10-24`.
- The supported APIs do not expose an immutable Figma version-history revision identifier. **EIM v1, 2026-10-24** is a named contract revision over the exact nodes below; it is not a frozen historical version. The session UUID is not revision evidence.
- The frames contain explicitly synthetic media/business fixtures. Production components must receive current typed data and commands.

| Foundation | Exact collection |
| --- | --- |
| Primitive values | `VariableCollectionId:22:1922` |
| Light semantics | `VariableCollectionId:22:1940` |
| Dark semantics | `VariableCollectionId:22:1959` |
| Spacing and radii | `VariableCollectionId:22:1978` |

The ledger records 17 primitives, 18 semantic colors per theme, 15 layout variables, and 9 Inter text styles. Light and Dark use separate semantic collections; preserve their equivalent role names when exporting to code.

## Matched reference frames

| Experience | Mobile 390 × 884 | Web 1440 × 1000 |
| --- | --- | --- |
| Home | `24:1984` | `25:2026` |
| Recording | `24:2027` | `25:2071` |
| Checked review | `24:2047` | `25:2103` |
| Confirmed receipt | `24:2068` | `25:2137` |
| Connected Proof record | `24:2086` | `25:2168` |

These dimensions define comparison fixtures, not fixed runtime screen heights. Narrow widths, large text, keyboards and safe areas must reflow.

## 27-state migration map

The new appearance never changes the authority behind a state.

| # | State | Historical node | New mobile node | Required binding |
| --- | --- | --- | --- | --- |
| 01 | Home | `2:294` | `24:1984` | Current workspace, pending work, exact resume targets |
| 02 | Library local | `2:295` | `26:2033` | Owner-scoped local original, distinct from confirmed record |
| 03 | Name item | `2:296` | `26:2068` | Persisted entry and existing idempotent create operation |
| 04 | Capture guide | `2:297` | `26:2081` | Exact Proof, capture authority, actual permissions |
| 05 | Recording | `2:298` | `24:2027` | Native session, real timer, working Stop and item identity |
| 06 | Leave recording | `2:299` | `26:2096` | Same active session; stop waits for actual persistence |
| 07 | Review unchecked | `2:300` | `26:2111` | Selected valid take; submit blocked until declaration |
| 08 | Review checked | `2:301` | `24:2047` | Consent bound to current identity/revision; duplicate-safe submit |
| 09 | Uploading | `2:302` | `26:2129` | Persisted operation and actual transport progress |
| 10 | Upload paused | `2:303` | `26:2145` | Classified cause and same-operation resume |
| 11 | Confirmed receipt | `2:304` | `24:2068` | Fresh/reconciled canonical outcome and matching evidence/receipts |
| 12 | Connected record | `2:305` | `24:2086` | Authorized original, statements, source history, supported actions |
| 13 | Activity saved | `2:306` | `26:2160` | Actual completion event; correct cold/warm destination |
| 14 | Recovered recording | `2:307` | `26:2194` | Inspected surviving file; interruption metadata; eligibility separate |
| 15 | Share Proof | `2:308` | `26:2213` | Actual link operation and access policy |
| 16 | Original viewer | `2:309` | `26:2228` | Exact authorized object, full orientation/aspect, correct return |
| 17 | Home saved | `2:310` | `26:2244` | Canonical recent record and consistent counts |
| 18 | Retake candidate | `2:311` | `26:2282` | Retain selected take; separately persist and accept candidate |
| 19 | Home paused | `8:1329` | `26:2301` | Same paused operation and useful next action |
| 20 | Home uploading | `8:1411` | `26:2336` | Observe actual transfer/confirmation; reopening never restarts |
| 21 | Link copied | `8:1494` | `26:2371` | Successful clipboard write for intended record |
| 22 | Library saved | `8:1626` | `26:2384` | Canonical record; stable filters, selection, refresh |
| 23 | Library paused | `12:1441` | `26:2419` | Same operation/reason as Home and Activity |
| 24 | Library uploading | `12:1587` | `26:2453` | Actual progress; stable row identity and scroll |
| 25 | Activity local | `12:1733` | `26:2487` | Owner-scoped journal event, distinct from server confirmation |
| 26 | Activity paused | `12:1831` | `26:2519` | Actual reason, exact operation, useful recovery destination |
| 27 | Activity uploading | `12:1911` | `26:2553` | Observe continuing operation without owning/restarting it |

Production coverage must also include loading/refresh failure, first use/no results, expired sign-in, forbidden/missing record, permission denial/permanent denial, camera start failure, low storage, stopping/checking, missing/corrupt media, candidate review/acceptance failure, queued/confirming, expired media URL, link failure and interrupted upgrade. Their new nodes are listed in the supporting-state inventory below.

## Component contract

| Family | Node | Recorded states |
| --- | --- | --- |
| Primary action | `23:1933` | Default, Focus, Pressed, Disabled, Loading, Error |
| Secondary action | `23:1946` | Default, Focus, Pressed, Disabled, Loading, Error |
| Status badge | `23:1959` | Local, Queued, Uploading, Confirming, Confirmed, Attention |
| Main navigation | `23:2017` | Home, Proofs, Activity |
| Task header | `23:2018` | Base specimen |
| Proof row | `23:2021` | Default child; six-state family below |
| Source label | `23:2024` | Default child; six-state family below |
| Timeline node | `23:2027` | Default child; six-state family below |
| Source inspector | `23:2030` | Default child; six-state family below |
| Media frame | `23:2033` | Default child; six-state family below |
| Declaration panel | `23:2036` | Default child; six-state family below |
| Exact operation progress | `23:2039` | Base specimen |
| Recovery notice | `23:2042` | Default child; six-state family below |
| Receipt | `23:2045` | Base specimen |
| Tabs | `23:2048` | Default child; six-state family below |
| Drawer/sheet | `23:2051` | Default child; six-state family below |
| Form field | `23:2054` | Default child; six-state family below |
| Empty/error/loading | `23:2057` / `23:2060` / `23:2063` | Base specimens |

Component review frame: `23:2066`. Primary action’s text property is `Label#23:0`. Ten interactive base specimens were subsequently promoted to six-state component families. Their original standalone IDs remain as `State=Default` children under the family IDs below. Other base specimens remain explicitly listed as such.

## Token and layout export

| Role | Value / requirement |
| --- | --- |
| Midnight backdrop | `#06101E` |
| Navy shell / light-mode ink | `#0A172A` |
| Brand blue atmosphere | `#3478FF` |
| Primary action | `#235FE0`, white label |
| Mint accent | `#21D6A0`; completion treatment only for confirmed outcome |
| Cyan / dark focus emphasis | `#65DFF7` |
| Paper canvas | `#F6F9FD` |
| Elevated light surface | `#FFFFFF` |
| Raised dark surface | `#10243D` |
| Secondary text | Light `#536277`; dark `#A5B6CB` |
| Borders | Light `#D9E3EF`; dark `#29415E` |
| Recording / error | `#E95A5A` / `#C13338`; always include words/icon |
| Confirmed ink / selection wash | `#073D2E` / `#E9F0FF` |

Use semantic roles, not raw hex values scattered across screens. The raw brand blue is not the ordinary white-label button fill. Figma variables carry scoped bindings and code syntax; reconcile exact exported CSS names with the canonical repository token source before generating platform outputs.

| Inter role | Size / line height | Weight |
| --- | --- | --- |
| Mobile display | 40 / 44 | Extra Bold |
| Desktop display | 48 / 52 | Extra Bold |
| Screen title | 28 / 34 | Bold |
| Section | 20 / 26 | Bold |
| Body | 16 / 24 | Regular |
| Strong | 16 / 24 | Semi Bold |
| Secondary | 14 / 20 | Medium |
| Caption | 12 / 18 | Semi Bold |
| Button | 16 / 22 | Bold |

The new Inter prescription supersedes SIGNAL’s Space Grotesk/Manrope for the evolved interface. Register genuine native weights; do not synthesize bold.

- 4-unit base. Gaps: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64.
- Phone: 24 gutter at 390/412; 20 at narrow widths. Main reference work width 342 at 390.
- Home: compact navy feature panel, approximately 160–200 high at default text size; one dominant next action; quiet evidence rows.
- Desktop: 240 rail in the reference, 48 workspace padding; adapt within plan’s 224–256 rail range.
- Primary touch action: 56 high. Icon hit area: at least 48 × 48 logical units.
- Control/card/sheet radii: 8 / 16 / 24. Card padding: 16–24.
- Responsive checks: phone 360/390/412; tablet 768/834; desktop 1280/1440/1920; web reflow 320 CSS px.
- No fixed-height runtime assumption. Scroll long content and large text; keep declaration, Stop and sole next action reachable.

## Motion and accessibility

| Motion | Timing | Contract |
| --- | --- | --- |
| M01 Press/focus | 80–120 ms | Immediate visible focus; action independent of callback |
| M02 Tab/selection | 160–180 ms | Selection immediate |
| M03 Screen | 220–280 ms | Small travel/dissolve; preserve camera owner |
| M04 Sheet/inspector | 240–320 ms | Focus and dismissal controlled |
| M05 Card-to-record | 240–320 ms | Non-owning identity proxy |
| M06 Home assembly | 420–600 ms | Once per cold workspace entry |
| M07 Timeline/source | 180–240 ms | Only changed/selected node |
| M08 Receipt | 480–720 ms | Once per confirmed operation; actions usable from first frame |
| M09 Progress | At most 120 ms smoothing | Actual transport values only |
| M10 Desktop hover | 120–180 ms | Border/light; optional decorative tilt at most 2° |

Initial web easing: `cubic-bezier(.2,.75,.2,1)`. Prefer transforms/opacity. System follows OS; Reduced removes travel, parallax and scale with brief fades; Off is immediate. An OS reduced-motion request cannot be silently overridden. Change motion policy without remounting capture. Suppress decoration while recording, backgrounded, in station throughput mode or on measured constrained hardware. No persistent loops, autoplay, scroll hijacking or blur over the camera.

Target WCAG 2.2 AA for web plus project requirements: normal text at least 4.5:1, large text at least 3:1, meaningful non-text/focus contrast, logical keyboard order, focus restoration, accessible names/roles/states, 200% text scaling and 320px reflow. Words/icons supplement color. Announce meaningful stage changes, not every timer/progress tick. Preserve native playback and media orientation. Automated checks do not substitute for TalkBack/VoiceOver and keyboard task walkthroughs.

## Existing owners remain authoritative

- Current server contracts own canonical state; existing capture/durable operation owners own device work. Components project state and dispatch commands.
- Keep environment/account/workspace/Proof/take/operation identity through routes, notifications, retries, media and async callbacks. Reject stale/mismatched results.
- Local save, transport completion, canonical confirmation, finalized record and carrier-reported shipment state are distinct. A 100% upload cannot display the saved receipt.
- Opening/canceling retake preserves the current take and declaration. Candidate stays separate; durable acceptance precedes eligible cleanup and resets consent.
- Consent binds account, Proof, take/hash and material-description revision. Never carry it onto a replacement take.
- Closing progress does not restart or own upload. Lost responses reconcile the same operation. Preserve originals until current cleanup policy permits removal.
- Original playback stays unmodified and uncropped at full aspect/orientation. A derivative or design fixture never substitutes for it.
- Preserve account/deletion/sign-out safeguards, supported utilities, capabilities and station Scan → Ready to pack → Record → Done. Capability-gate unavailable connections/admin/claims actions.
- Scope app CSS; hosted web source and repository website snapshot are separate. Preserve auth, bridge, public routes and live backend additions.
- Native/iOS/desktop adaptation must respect existing permission, file, IPC, update/signing and native lifecycle boundaries. No framework/camera/uploader rewrite for visual convenience.

## QA record and open work

| Evidence | Current status |
| --- | --- |
| Original SIGNAL page retained | Recorded as preserved in ledger |
| 27 new mobile states and 5 matched web frames | Created with exact node IDs |
| Mobile Home visual composition | Reviewed; wrapping correction applied |
| Mobile confirmed receipt visual composition | Reviewed |
| Desktop Home visual composition | Reviewed; selected-navigation contrast correction recorded |
| Remaining individual screens | Structurally inspected; individual visual review not claimed |
| Supporting states / station / Motion / Handoff / theme and constraint references | Created; exact IDs below |
| Immutable version-history ID | Unavailable through supported APIs; named contract revision recorded |
| Real integration, installed-device and release acceptance | Not executed by design work |

Before G1 closes, reconcile the remaining applicable component and width/theme/large-text checks, finish pending post-fix visual reviews, and retain the named revision limitation. The 150% text fixture is a design example; it does not establish the required runtime 200% text accessibility pass. Each implementation coverage entry still needs route/component, real owner, fixture, motion ID, screenshot, integration evidence, test status and known discrepancy. Record Passed / Failed / Not executed / Not applicable honestly with commit/environment/device/date. Build success, design completion and publication are separate facts.


## Supporting, station, theme and constraint references

| Supporting state | New node |
| --- | --- |
| Loading | `27:2260` |
| Refresh failed | `27:2266` |
| First use | `27:2274` |
| No results | `27:2282` |
| Expired session | `27:2290` |
| Forbidden record | `27:2298` |
| Missing record | `27:2306` |
| Permission denied | `27:2314` |
| Permission permanently denied | `27:2322` |
| Camera failure | `27:2330` |
| Low storage | `27:2338` |
| Stopping/checking | `27:2346` |
| Missing/corrupt media | `27:2352` |
| Retake failure | `27:2360` |
| Queued | `27:2368` |
| Confirming | `27:2376` |
| Expired media access | `27:2384` |
| Share failure | `27:2392` |
| Interrupted upgrade | `27:2400` |
| Photo task | `27:2406` |
| Motion preferences | `27:2414` |

| Station / documentation / constraint | New node |
| --- | --- |
| Station Scan | `27:2422` |
| Station Ready | `27:2434` |
| Station Recording | `27:2444` |
| Station Done | `27:2454` |
| Foundations | `27:2464` |
| Motion specification | `27:2484` |
| Handoff | `27:2490` |
| Dark Home | `28:2282` |
| Dark record | `28:2325` |
| Home 360 constraint | `28:2372` |
| Home 412 reference | `28:2415` |
| 150% large-text fixture | `29:2357` |

All displayed business/media content remains synthetic. The historical SIGNAL page is untouched. These references establish design coverage; they do not establish actual camera, station hardware, persistence, upload or device acceptance.

## Added interactive variant families

Each family below has Default, Focus, Pressed, Disabled, Loading and Error states. The earlier component-table ID identifies its retained default child.

| Family | New component-set node |
| --- | --- |
| Proof row | `28:2473` |
| Source label | `28:2489` |
| Timeline node | `28:2505` |
| Source inspector | `28:2521` |
| Media frame | `28:2537` |
| Declaration panel | `28:2553` |
| Recovery notice | `28:2569` |
| Tabs | `28:2585` |
| Drawer/sheet | `28:2601` |
| Form field | `28:2617` |

Visual QA reported by the design owner as reviewed and passing: mobile Home, mobile confirmed receipt, mobile upload paused, desktop Home, 360 Home, Station Scan, Confirming and the component specimen. Dark-navigation contrast and action/nav-label centering were corrected; post-fix screenshots passed for dark Home, ordinary mobile Review and Station Scan. Large-text media growth, Proof-tab selection/chronology lane and 360/412 navigation sizing were subsequently corrected and structurally verified. The final screenshot calls for those last three changed references were blocked by the connected Figma Starter plan tool-call limit, so their post-fix visual checks remain Not executed. Other screens have structural inspection only. No real integration or installed-device acceptance is claimed by this design handoff.


## Final structural evidence and verification limit

The final read confirmed 68 new variables across four EIM collections, nine Inter styles, 14 component sets, 87 editable master components, 805 Inter text nodes, and all 27 evolved mobile screen references. All new design content is editable text, frames, components and vectors; no flattened full-screen image was imported. The original SIGNAL page `0:1` still has its original 75 top-level objects.

The connected Figma account is nericollin@thepackproof.com on the Starter plan. The final three requested screenshot calls returned the Starter tool-call-limit error. No upgrade, paid-plan change or alternate access route was attempted. This limits final post-fix screenshot evidence; it does not undo the saved Figma work. Large-text fixture (`29:2357`), connected record (`25:2168`) and 360 constraint (`28:2372`) retain their explicit pending post-fix visual status. The 412 constraint is structurally checked only. Runtime behavior, 200% text, integration and physical-device acceptance remain implementation responsibilities.

The connected-record source lane is node `30:2359`. Its selected event is Packing recorded, matching the seller-recording inspector. The named revision is EIM v1, October 24, 2026. No immutable Figma version-history identifier is exposed by the supported tools.
