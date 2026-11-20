# Approved PackProof Windows design authority

**Approved by PackProof's founder on November 20, 2026.** This file is intentionally committed to the repository's **default `main` branch** so that agents starting fresh conversations encounter the approved design even when the current Windows release work is on a different branch.

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

## Where development currently lives

Active Logistics-enabled Windows release baseline: `release/logistics-129-pilot`. The default `main` branch **is not by itself evidence of the most recent Logistics Windows implementation**. Identify the current release/source commit before any changes.

- Implementation reconciliation PR: https://github.com/thepackproof/packproof-v2/pull/178
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
