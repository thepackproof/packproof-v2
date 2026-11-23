# PackProof Windows UX and functional authority

**Status:** Binding release contract for the unified Logistics-enabled Windows distribution; the existing Commerce renderer remains supported but must not replace the default Logistics journey.

## Source of truth (not a chat transcript)

1. **Approved visual design:** [PackProof Connect 2.0, Figma file PZ8dfCcXe2D8SMtmF497v3](https://www.figma.com/design/PZ8dfCcXe2D8SMtmF497v3/PackProof-Connect). The real Figma frames, component instances, branded imagery and visible interaction states prevail over agent-authored visual approximations. Do not regenerate the UI from a prose summary.
2. **Working functionality:** Existing Connect Windows LocalService, facility draft and read-only source approval flows, canonical Proof ordering and evidence originals, hosted facility access and account scope, and Commerce's native evidence queue. The Figma prototype does *not* create authority to bypass backend validation or persist sample data as a real Proof.
3. **Mapped runtime:** `connect-windows/design/windows-ux-contract.json` names the actual codepaths and approved frame IDs. Update this map when intentionally changing implementation ownership. No independent unreferenced React/CSS alternative may be substituted into the installer.

## Design-to-code route ownership

| User journey | Figma design node(s) | Runtime implementation | Required real operation |
| --- | --- | --- | --- |
| Unified entry and choice | `2:9` | `desktop/src/renderer/LogisticsGateway.tsx`, `App.tsx` | Authorized `workspace.choices`; `workspace.orders` or `workspace.setup`. Commerce only by explicit choice. |
| Familiar order and guided connection | `69:8866`, `69:9201`, `69:9404` | `connect-windows/ui/experience/GuidedSetup.tsx`, `Setup.tsx` | Approved source discovery, read-only choices, field mapping and source review through the native bridge. |
| Source validation and historical preview | `69:9490`, `70:9666`, `71:9768` | `connect-windows/ui/experience/GuidedSetup.tsx`, `Proof.tsx` | Actual matching/qualification, source attribution and operator consent, not UI-only success. |
| Active collector and operator home | `71:10079`, `5:9`, `83:9202` | `connect-windows/ui/experience/Workspace.tsx`, `WorkspaceApp.tsx` | Live LocalService status, ordered exceptions and facility-scoped orders. |
| Singular evolving order Proof | `20:1744`, `83:9034`, `83:9112` | `connect-windows/ui/experience/Proof.tsx`; existing backend projection | Stable Proof ID, evidence chronology, original source inspection, revisions and late-arrival handling. |
| Source repair | `83:9262`, `5:255` | `connect-windows/ui/experience/Workspace.tsx`, `GuidedSetup.tsx` | Troubleshooting with native service state; retry/replay never fabricates completed evidence. |

The detailed functional rules and acceptance examples are in Figma page `79:8804`: discovery `81:8900`, familiar-order validation `81:8949`, evolving Proof `81:8998`, operator workflow `81:9047`, and breakdown `89:9236`.

## Approved UX acceptance charter

The Figma design's **UX acceptance charter** (node `6:116`) is binding, not commentary. Implement and review these eight rules: ask one meaningful thing at a time; explain each user choice; confirm actual success rather than a selected folder; make errors recoverable; return after authorization to the exact task; reveal a familiar, genuinely reconstructed order before declaring setup complete; let automation continue without constant supervision; keep advanced controls optional. A new user must be able to connect records, verify an order, and know what happens next. A beautiful unactionable prototype fails this charter.

## Runtime boundaries and nonnegotiable invariants

- **A single installed application may host multiple workflows, but not competing versions of the same workflow.** Connect's `experience/` tree owns Logistics. The desktop `App` owns Commerce. The unified entry owns selection and does not reproduce either application's internal screens.
- No new CSS or markup may silently substitute an unapproved screen for an approved Logistics one. Legacy desktop `styles.css`, `signal.css`, and `evidence-in-motion.css` remain Commerce-only; `connect-windows/ui/experience/experience.css` owns Logistics. Their consolidation is a separately reviewable migration, not an unsafe blind deletion.
- Preserve the installed LocalService, protected queues, customer/organization isolation, explicit approvals, original evidence, retained credentials and safe rollback. Never remove production data or weaken authorization to make the demo appear successful.
- Source files are read-only inputs. An AI suggestion is advisory and never silently activates collection or grants permissions.
- A missing permission, offline service, changed facility, or failed API call must be **visible and actionable**. Do not turn all failures into “Logistics unavailable.”
- Use human-facing order references, carton identifiers, shipment status and attention reason as prominent content; raw Proof IDs and account email are secondary identifiers.
- No success-looking fake records in production views. Fictional previews must be clearly labeled as examples.

## Release acceptance protocol

1. **Build provenance:** Pin the exact commit and Figma contract revision. Run `node connect-windows/scripts/verify-windows-ux-contract.cjs --unified` after unified bundling; fail packaging if expected Logistics entry or Connect experience is missing.
2. **Functional evidence:** Test facility choices, authorized setup, one real/fixed-fixture source, order reconstruction, stable Proof identity across a delayed receipt, and recovery when a source becomes unavailable. Confirm Commerce recording and staged uploads survive installation/upgrade.
3. **Visual evidence:** Capture *the actual packaged unified Windows interface*, not a standalone Figma preview or `connect-windows` renderer. Compare light theme at 1440×900 and 1280×800 / 125%, for entry, setup, active workspace, order Proof and recovery, against the named Figma nodes. Record differences; review visually before calling it approved.
4. **Release decision:** No public/pilot promotion on TypeScript compilation, synthetic screenshots, or happy-path HTTP tests alone. A missing visual receipt or an unverified runtime path means **not qualified**, not “passed.”
5. **Handoff:** Every agent starts by checking this file, Figma nodes and current release commit. Changes must name the owning route and service action. No new conversation is allowed to reinterpret the design as a purely visual prototype.

## Work currently outside this patch's proof of completion

The initial route/error correction and static build contract do not by themselves establish full pixel-level parity, signed installer readiness, or successful live facility authorization. Those remain explicit release gates, not implied claims.

## Real light/dark visual acceptance (updated after screenshot audit)

The packaged Figma-aligned Proof now places the authentic event timeline and
source summary before the legacy grid. The dark theme explicitly reskins nested
quantity/delivery controls, and the sidebar keeps the brand fixed while only
the navigation list scrolls. The packaged acceptance harness checks those
specific surfaces and the brand's visible bounds rather than relying on a
TypeScript compilation or screenshots alone.

The original Windows visual runner emulated the operating-system color scheme but did not switch the actual PackProof appearance preference; the exported dark and light operations screenshots were pixel-identical. This is **not** qualified visual evidence. The corrected source runner activates the actual in-app theme, asserts the rendered theme attribute and computed background, and rejects identical light/dark overview captures. The unified installer additionally checks selected active Logistics routes in both appearances at Windows scales. The founder-approved Evidence OS guided setup now exposes an actual persisted application light/dark control, shared with the active shell, without changing source permissions or service operations. The November 23 Windows candidate run [#45164154892](https://github.com/thepackproof/packproof-v2/actions/runs/45164154892) passed native packaged renderer/LocalService/clean+upgrade tests for implementation commit `a1f82627b0a8480b5e80285c3ef4ad0bea0a0052` (tested merge commit `bcf7dcdbc5708e3707e539e9caa62ed4504ebf9a`). Its verified evidence artifact `unified-windows-ux-evidence-bcf7dcdbc5708e3707e539e9caa62ed4504ebf9a` contains all four guided stages in both actual application appearances at 1440×900 / 100% and 1280×800 / 125%. The runner checked distinct computed surfaces, `rgb(246, 248, 252)` (light) and `rgb(7, 19, 33)` (dark). These are **packaged unified renderer screenshots under controlled synthetic IPC**; visual parity with Figma, real external hardware/facility acceptance, signed distribution and pilot release remain **unqualified**.

## Evidence OS extension — 2026-11-22

The founder-approved PackProof Evidence OS Figma file is `nNnkgTZOBNkG8muy8AkIv1` (https://www.figma.com/design/nNnkgTZOBNkG8muy8AkIv1). The new visual and interaction design supersedes the older **appearance** target for the active Logistics workspace. It does **not** supersede authenticated facility scope, consent, full-original preservation, durable ordering and versioning, or original access safety; those functional requirements remain binding.

| Evidence OS visual frame | Runtime ownership / status | Functional boundary |
| --- | --- | --- |
| Dashboard `3:262` | `connect-windows/ui/experience/OperationalSignal.tsx`; work in progress | Use real `ConnectStatus.workspace` data and honest unavailable states, not Figma mock statistics. |
| Application shell `3:262`, light `8:258` | `connect-windows/ui/experience/Shell.tsx`, `EvidenceOS.css`; work in progress | Navigation must still reach the authorized existing Logistics screens; theme preferences must not alter access control. |
| Intelligent setup `3:15`, scan `3:97`, approval `3:168` | Existing `GuidedSetup.tsx`, `WorkspaceConnections.tsx`; visual parity open | Consent-checked source discovery and backend review remain authoritative. |
| Per-order Proof `4:122`, matching `4:230`, integrity `5:190`, finalized `5:381` | Existing `Proof.tsx` and canonical API; visual parity open | Stable Proof identity and source-original/revision traceability; no heuristic identity merge. |
| Exceptions `4:322`, recovery `4:410`, outputs `5:286` | Existing `Workspace.tsx`, `LocalService`, export pipeline; visual parity open | No synthetic green states, lost evidence or unapproved source access. |

Build gate: `node connect-windows/scripts/verify-windows-ux-contract.cjs --unified` checks source-to-design linkages; this is necessary but **not sufficient** for runtime qualification. The regression suite must still test actual installed Windows with scoped multi-source folders, late/corrected events, restart/outage recovery, approval return, proof revision identity and rendered screenshots at requested display scaling. No release claim until those receipts are present.

## Commerce regression acceptance — authorized repair (2026-11-21, Eastern)

Keeping the existing Commerce renderer and its CSS preserves implementation ownership. It does not require retaining known contrast, spacing, hierarchy or responsive-layout defects. Repair those defects within the Commerce owner while keeping Logistics owned by the existing Connect experience. Shared shell or branding changes must remain legible in their actual light and dark callsites.

Reuse the current approved angular PackProof symbol at `web/public/brand/connect/packproof.png` (Git blob `5224892f4b09263e486751ae3848a92aba7ca560`), matching Figma node `28:1174` and the existing Connect `Brand` component, with the established sans-serif PackProof lockup. Preserve the artwork and its aspect ratio; use a light backing where needed for legibility on the navy sidebar, verify the packaged asset path, and record its exact repository source. Do not recreate or recolor the symbol, substitute the obsolete Signal arrow, or treat the repository's old hexagon/serif assets as the current approved identity.

The packaged unified Windows acceptance evidence must include **Commerce Home, Packing Station, Orders and Settings**, in **both light and dark appearance**, at **1440×900 / 100%** and **1280×800 / 125%**. Review the actual full-size captures for readable profile/account text, usable headings and actions, appropriate content widths, aligned controls, paired date filters and absence of clipped or overlapping content. These captures supplement every existing Logistics frame and functional acceptance requirement; they do not replace them.

Settings evidence must show both workstation preferences and the **complete optional timing-study statement**. In the not-enrolled scenario, the consent checkbox starts unchecked, the acknowledgment remains adjacent to its control, and joining requires the existing explicit acknowledgment and action. Reordering or restyling Settings must not shorten or hide the statement, preselect consent, change collection behavior, or change withdrawal and retention semantics. Existing consent is not reset to manufacture an unchecked screenshot.

Record source and artifact identity with the visual evidence. A separate preview, a screenshot from an older source, or a passing layout assertion alone does not establish acceptance of the delivered executable. Preserve all existing authorization, source access, original-evidence, protected-queue, installation/upgrade and live-facility requirements above.


## Evidence OS native guided appearance receipt — 2026-11-23

- **Visual authority:** Figma `nNnkgTZOBNkG8muy8AkIv1` first-run `3:15`, discovery `3:97`, source approval `3:168`; detailed functional consent authority remains the earlier approved `PZ8dfCcXe2D8SMtmF497v3` setup. This is **theme support**, not full replacement of the functional guided screens or final pixel parity.
- **Owning runtime:** `WorkspaceApp.tsx` mounts the existing `Setup.tsx`/`GuidedSetup.tsx`, reading and writing the same presentation preference as `Shell.tsx`; `GuidedSetup.css` handles light/dark and reduced motion. It continues calling the protected facility draft, native folder discovery/inspection, order preview/replay and browser approval methods. No source consent bypass and no fabricated completed orders.
- **Regression:** `WorkspaceApp.test.tsx` asserts dark/light round-trip while the facility has not been activated. `workspace-layout.cjs` exercises both appearances for `guided-order`, `guided-sources`, `guided-review` and `guided-activate` at both required Windows scales, verifies computed colors and stores native packaged renderer captures. `check-renderer-layout.cjs` enables those dark scenes. Packaged fixture screenshots do not replace an installed operator review.
- **Provenance:** implementation head `a1f82627b0a8480b5e80285c3ef4ad0bea0a0052` / packaged merged test SHA `bcf7dcdbc5708e3707e539e9caa62ed4504ebf9a`; [Windows candidate #45164154892](https://github.com/thepackproof/packproof-v2/actions/runs/45164154892), artifact ID `14812493782`. Documentation-only follow-up commits are not represented by that source artifact; verify their own head workflows before calling a newer head green.
