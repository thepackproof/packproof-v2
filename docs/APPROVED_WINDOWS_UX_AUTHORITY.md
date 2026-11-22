# Approved PackProof Windows design authority

**Approved by PackProof's founder on November 20, 2026.** The approved design authority is committed to the repository's default `main` branch and to the qualified Logistics release, so new agents inherit the source-of-truth design in either workflow.

## Canonical Figma design

- Approved file: https://www.figma.com/design/PZ8dfCcXe2D8SMtmF497v3/PackProof-Connect
- File key: `PZ8dfCcXe2D8SMtmF497v3`
- Welcome concept: `2:9`
- UX acceptance charter: `6:116`
- Guided facility setup, beginning with a known order: `69:8866`
- Source discovery: `69:9404`
- Source inspection: `69:9490`
- First reconstructed Proof: `70:9666`
- Active facility workflow: `71:10079`
- Daily workspace: `5:9`
- Singular order Proof: `20:1744`
- Functional architecture and detailed acceptance: `89:9236`

The design is approved. Do **not** ask the founder to re-approve it or invent another visual layout from a written development plan.

## Latest visual direction — Evidence OS, November 22, 2026

After the approval documented above, the founder approved a **new 14-screen PackProof Windows Evidence OS visual target**: https://www.figma.com/design/nNnkgTZOBNkG8muy8AkIv1 . This newer visual direction controls the proposed appearance, motion, layout, navigation language and workspace presentation; the earlier Figma remains the detailed **functional** authority for existing setup consent, source review and original/evidence lifecycle semantics until each replacement path is fully accepted.

- New dashboard frame `3:262`; real runtime `connect-windows/ui/experience/OperationalSignal.tsx` and pure scope-aware service projection `operations-overview.ts`.
- Unified per-order Proof visual `4:122`; existing real owner remains `connect-windows/ui/experience/Proof.tsx`.
- Discovery `3:97`, source approval `3:168`, matching `4:230`, exceptions `4:322`, recovery `4:410`, integrity `5:190`, outputs `5:286`, finalization `5:381`, light mode `8:258`; scope and incomplete status are recorded in `connect-windows/design/windows-ux-contract.json`.
- Figma values such as 2,407 orders and 98.2% coverage are **fictional**. Never show them in the real app unless actual service data proves them. Unknown totals must remain unknown.
- Native animation, editable Figma components, and clickable navigation prove the design—not backend connectivity. Continue using live LocalService and authenticated APIs; do not recreate another unconnected desktop renderer.

**Release evidence for this visual extension remains outstanding:** compiled package, installed 100%/125% visual acceptance, security review, end-to-end folder-to-Proof acceptance, full error/restart/recovery, and legitimate backend receipts. A draft design/implementation PR is not a customer release.

## Where development currently lives

Active Logistics-enabled Windows release baseline: `release/logistics-129-pilot`. The default `main` branch **is not by itself evidence of the most recent Logistics Windows implementation**. Identify the current release/source commit before any changes.

- Implementation reconciliation: [PR #178](https://github.com/thepackproof/packproof-v2/pull/178), merged into `release/logistics-129-pilot` after Windows clean-install and upgrade checks.
- Canonical implementation contract in that PR: `docs/WINDOWS_UX_IMPLEMENTATION_CONTRACT.md`
- Machine-readable Figma-frame / component / functional-operation map in that PR: `connect-windows/design/windows-ux-contract.json`

If that PR is merged, follow the merged release source; do not copy its stale head branch SHA into a new development task.

## Mandatory development policy

1. Read Figma **itself** and the actual deployed Windows source before coding. A detached development plan and a new agent conversation are insufficient design or implementation authority.
2. Use the existing functional Windows LocalService, evidence capture and retention engine, authorized organization and facility scopes, source readers and canonical Proof APIs. Never replace these with a merely visual prototype.
3. A UX control must call a real, guarded service operation or clearly disclose its unavailable state. Never silently turn success into a sample or mock record.
4. Keep one owner for the Logistics experience. Do not fall back silently to a legacy UI, drop the user in Commerce by default, or add a second competing design layer.
5. Preserve originals and queued evidence through installs/updates. Never weaken approval, identity, facility scoping or custody rules to make a demo look polished.
6. Verify the **packaged unified Windows executable**, its full-size screens and core workflows. Pass/fail of a separate Connect preview is not sufficient. Measure at 1440x900 and 125% scaling; review approved Figma frames versus the installed app.
7. Release acceptance: users can connect existing source records, verify a familiar real order, inspect one evolving Proof, and understand the next action. Code compilation without visual/functional receipts is *not* release qualification.

If the source/Figma/design-to-code contract is not accessible in a new chat, explicitly flag the missing artifact rather than silently inventing its contents.
