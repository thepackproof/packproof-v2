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
