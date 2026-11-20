# PackProof V2

Independent repository. Not a branch or fork of the legacy PackProof app.

Authoritative specification: [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)

Architecture for this repo: [docs/architecture.md](docs/architecture.md)

Legacy system (do not modify from this repo): `C:\src\PackProof\repo` at `origin/master` (`c24cd22`). Recommended tag in that repo, applied separately: `legacy-v1`.

## Founder-approved Windows UX and functional continuity

For all work touching PackProof Windows / Connect / Logistics, **read and follow [docs/APPROVED_WINDOWS_UX_AUTHORITY.md](docs/APPROVED_WINDOWS_UX_AUTHORITY.md) before editing**. This document is the permanent cross-conversation handoff; it references the exact approved Figma file, named nodes, current release branch and implementation contract. The user's Figma design is already approved. A newly opened chat or a development plan attachment is *not* permission to reconstruct the UI or substitute a nonfunctional prototype for the protected existing codebase.

Do not assume `main` is the newest Windows release. Verify the active Logistics release line and packaged renderer before beginning or reporting completion.

## PackProof Windows / Logistics (mandatory for all coding agents)

Before modifying `desktop/`, `connect-windows/`, the unified installer, Windows release CI, or any related UI:

1. Read [the Windows design-to-runtime contract](docs/WINDOWS_UX_IMPLEMENTATION_CONTRACT.md) and [its machine-readable Figma-to-code map](connect-windows/design/windows-ux-contract.json). These files are binding even when a new chat does not include the earlier design discussion.
2. Open the actual approved Figma Design file `PZ8dfCcXe2D8SMtmF497v3` and inspect the exact frame IDs in the contract. The Figma screens and UX charter `6:116` are normative for appearance and interaction; do not reconstruct the approved designs from a prose handoff.
3. Preserve existing working services and the protected Windows evidence queue. Every visible action must call the existing authorized implementation or explicitly state why the feature is unavailable. No replacement visual prototypes, silently disabled actions, simulated success, or parallel competing Logistics screens.
4. The unified Windows application must enter the Logistics flow by default, offer Commerce as an explicit separate choice, preserve actionable access failures and verify real order reconstruction from existing source records. Do not weaken facility scope or source approval for visual parity.
5. Confirm the exact packaged renderer source. Run the Windows UX build contract check and obtain a visual/manual receipt from the packaged *unified* app at 100% and 125% Windows display scaling, with the key Figma frames side by side. CI compilation is not visual acceptance.
6. On any proposed change or PR, list the Figma frame, owning component, service/API operation, tests/receipts, and remaining gaps. If you cannot access Figma or the actual Windows packaging environment, report the blocker explicitly. Never claim pixel parity or live rollout without evidence.

The legacy Commerce CSS remains scoped to Commerce until an approved component-by-component migration; do not delete it as a cosmetic shortcut.
