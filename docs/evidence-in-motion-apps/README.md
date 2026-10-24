# Evidence in Motion app implementation packet

Presentation source is implemented across web, shared Android/iOS, and desktop renderers. The candidate is under remote review in PR #130; final exact-source CI remains open. It is not fully complete or production-ready: real web end-to-end, physical phone recovery/upgrade and signed platform acceptance remain open.

## Packet

- [Baseline](baseline.md): upstream/hosted/backend identity and preserved owners/routes.
- [Design contract](design-contract.md) and [Figma ledger](figma-design-ledger.json): exact saved nodes, named revision, tokens and design-review limits.
- [Coverage](coverage.json): all 27 inherited states, 21 supporting production states, T01-T14 and source-backed AT01-AT28 mappings.
- [Independent source review](source-review.md): concrete findings, repairs and remaining fidelity/integration limits.
- [Acceptance](acceptance.md): actual saved check outputs, initial failures and current results.
- [Release and rollback](release-and-rollback.md): practical stop/go decision and exact release gates.

## Current evidence

Exact web dependency installation now uses Vite 7.3.7 / Vitest 4.1.12. The final web build and 28 focused tests in 7 files passed; saved web and mobile audit reports show zero reported vulnerabilities in their recorded scope. Final native compiler output has zero project diagnostics using installed dependency fallbacks; desktop now passes the full project compiler with exact installed dependencies. Earlier native 61 focused tests, 12 subsequent source-review tests, 4 motion checks, 19 theme/chronology checks and 3 genuine-font checks passed. Canonical token output/consumer drift checks passed.

Browser review observed actual 390x844 and 1280x720 component-gallery layouts, light/dark composition, exact source inspector selection, Motion Off and no horizontal overflow at those sizes. The desktop inspector now uses an adjacent aside at widths >=1200 CSS pixels in both source trees; at measured 1280x720 it was 470px wide, with no overflow and exact trigger focus restored on Close. Fixtures were explicitly synthetic; no browser camera or real canonical completion was exercised. Native installed screenshots, 320px reflow, runtime 200% text and full screen-reader walkthrough remain unexecuted.

| Gate | Current state | Remaining exit evidence |
| --- | --- | --- |
| G0 source reconciliation | Upstream b08daf7982bedb6916702b5e4ee237a314f726da; hosted 5b454f836872cc9292b4b12fc4709674bb5c2d37 / version 62; live backend 399f306a2fdac37511c8659c73d5a059dd759b7a unchanged | Final candidate SHA/CI, affected live capabilities, installed identities and comparable performance baseline |
| G1 design contract | Saved exact nodes and canonical v1.0.0 token source; limited component visual review | Remaining applicable fidelity/constraint/native comparisons; named revision limitation retained |
| G2 web reference | Exact local build/checks and limited gallery review passed | Real authenticated creation/capture/declaration/upload/canonical receipt/fresh record; retained hosted route/auth/bridge verification |
| G3 Android | Source and local compiler/focused checks passed; candidate versionCode 72 configured | Signed candidate on physical phone; recording/interruption/recovery/retake/upload/receipt and pending-work upgrade |
| G4 iOS | Shared source changed | Mac/signing/device candidate and affected physical native acceptance |
| G5 Windows/macOS | Renderer source and local compiler checks passed | Platform builds/packages, hardware/station/upgrade and signed distribution evidence |
| G6 publication | Authorized for completed webapp and Android; not submitted/live for this candidate | Applicable critical gates, exact artifact/source identity, rollback/forward-fix exercise and publication/post-release evidence |

## Practical stop/go

**Go:** continue remote exact-source CI, rerun Windows and affected remote checks after the exact desktop security-lock repairs, complete review builds, finish independent web/hosted checks and gather remaining acceptance evidence. No routine reauthorization is needed.

**Stop production activation:** the actual real web journey is not executed, and no physical phone is attached to the now-running ADB server. Android critical device/upgrade gates remain Not executed. iOS Mac/device signing and Windows/macOS platform packaging are not established. Prepare all independent work before requesting the specific missing phone/session or platform access.

The user authorized live webapp and Android publication upon completion. That authorization remains valid; it does not turn an unexecuted integrity/device gate into a pass. A validated earlier platform may release independently. Preserve originals, queued work, account/environment/Proof/take/operation identity, existing owners and supported routes throughout.

## Latest source and CI checkpoint

Hosted candidate version 65/source c093b45f35f4b68cfd8a1f6cb902404535f46339 is saved and not deployed. Version65 includes the adjacent-inspector repair and matches its recorded archive digest. Full hosted build passed with preserved Worker/auth/API bridge and 16 articles/7 topics/16 prerendered public pages. Current and hosted adjacent-inspector focused output each show 12 tests passed in 2 files.

At existing revision 35ed110, remote source checks, web bundle, Android JavaScript export and Mac Intel/ARM review installers passed. Broad PR Web/Mobile, three audits, scanner and PostgreSQL checks passed; Backend is still running, iOS simulator app and Share Extension passed at the existing checkpoint and Windows stale assertion is fixed locally; final remote rerun is pending. These are checkpoint facts, not a fully green pipeline, signed Android artifact, physical acceptance or final source SHA.

## Final local freeze checkpoint

Hosted candidate 65 is saved, not deployed: source c093b45f35f4b68cfd8a1f6cb902404535f46339; archive SHA-256 1b6b8129241a472ee957226ff3ea34893c0113dcc276aafdeddd4f17ae81d51e. This saved version includes the adjacent-inspector repair. See evidence/hosted-final-package-65.log.

Desktop exact-lock resolution with npm 11 addressed seven reported findings. The saved audit reports zero vulnerabilities, full project compiler succeeds with exact dependencies, and 44 focused checks in five files passed, including the corrected eight renderer checks. Final remote rerun after these dependency/source changes remains pending. The existing 35ed110 iOS simulator app and Share Extension passed; signed physical-device acceptance remains unexecuted. Production stop/go conditions above are unchanged.
