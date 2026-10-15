# S01–S09 design changes and explicit deviations

The original references are in the founder-supplied master plan. They are intentionally not copied into this public repository because they contain personal identifiers. The private review packet includes a nine-page annotated comparison with identifiers redacted from the supplied references. The before column below describes the visual observation; it does not claim the runtime source reproduces it. Proposed layouts are in the interactive prototype and static comparison PDF. Exact anonymized, installed-build before/after screenshots remain a native review deliverable.

| Reference | Before: observed reference | Proposed design | Source qualification |
| --- | --- | --- | --- |
| S01 Evidence | Receipt explanation and handoff compete with original evidence | Human title/status; required next step first; lean original list; technical receipt in Advanced | Inline ResearchPanel verified; live flag and installed version still need matching |
| S02 Integrations | Tall Shopify card, repeated disclaimers | Optional connection note once; compact truthful provider rows; details on tap | Availability must follow the real provider catalog |
| S03 Profile light | Sheet occupies much of viewport | Six compact destinations, account as small metadata, predictable close | Existing maxHeight is a ceiling, not a forced height |
| S04 Profile dark | Same content feels like full-screen panel | Same density and order as light; accessible contrast and bounded scrolling | Native focus/Back/safe-area still to test |
| S05 Capture | Scan/Create/Existing/queue/filter/search compete | Pack an item primary; Continue and Scan secondary; queue only when relevant | Empty-queue filter/search rendering confirmed |
| S06 Shipment | Expanded tracking form dominates | At rest: optional tracking summary; one focused form after Add tracking | Source already initializes closed; expanded screenshot is not proof of default defect |
| S07 History | Two events in spacious composition | Compact date grouping, event details on demand | Preserve legitimate blank remainder of short history; don't add filler |
| S08 Home | Email-like title, multiple apparent tasks | Human-readable title, one hero, distinct new-Proof route, up to three unique attention rows | Existing code already deduplicates hero; title origin unresolved |
| S09 Settings | Tall cards/groups | Compact grouped rows, appearance/notifications in capture group, distinct Advanced | Preserve billing/deletion/privacy/support and developer authorization |

## Controlled fixture decisions

- Prototype data are synthetic. No production API request, evidence upload, biometric authentication, real camera capture, payment, sign-in, connector installation or account deletion occurs.
- A simulated finalization is an explicit fixture transition and cannot be treated as a real finalized Proof.
- Default ordinary packing is a continuous-video fixture. Policy-dependent photo/grading/receiver capabilities require their distinct routes and runtime rules; design placeholders must not claim these native paths have been reimplemented.
- Prototype pixel width and text scale controls support design inspection, not measured Android dp/sp equivalence or TalkBack certification.
- Static PDF renders are HTML/CSS design renders. They do not establish live browser geometry, native font metrics or scroll/focus behavior.
- No new backend metadata, billing behavior, retention rule, evidence algorithm or public route renaming is authorized by a design choice.

## Approval decision record

Decision: PENDING.
Reviewed revision: `G1-2026-10-15-r1`; HTML SHA-256 `bf8227135610f54c266b6f20b3bc5a6cabb50f213d10f2382b17e0c84335e724`.
Founder: no approval recorded.
Required review: complete manual journey + saved-original recovery; light/dark; large text; all primary/secondary destinations.
Acceptable response: explicit G1 approved for the reviewed revision, or changes required.
Public release: remains separately gated at G4 even after G1 approval.
