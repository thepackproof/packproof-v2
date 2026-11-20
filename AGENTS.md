# PackProof V2

Independent repository. Not a branch or fork of the legacy PackProof app.

Authoritative specification: [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)

Architecture for this repo: [docs/architecture.md](docs/architecture.md)

Legacy system (do not modify from this repo): `C:\src\PackProof\repo` at `origin/master` (`c24cd22`). Recommended tag in that repo, applied separately: `legacy-v1`.

## Founder-approved Windows UX and functional continuity

For all work touching PackProof Windows / Connect / Logistics, **read and follow [docs/APPROVED_WINDOWS_UX_AUTHORITY.md](docs/APPROVED_WINDOWS_UX_AUTHORITY.md) before editing**. This document is the permanent cross-conversation handoff; it references the exact approved Figma file, named nodes, current release branch and implementation contract. The user's Figma design is already approved. A newly opened chat or a development plan attachment is *not* permission to reconstruct the UI or substitute a nonfunctional prototype for the protected existing codebase.

Do not assume `main` is the newest Windows release. Verify the active Logistics release line and packaged renderer before beginning or reporting completion.
