# Native acceptance ledger — not yet executed

Baseline: e71461c. Candidate Android build: none. G1 approval: pending. All device rows below are **NOT RUN**; passing model tests or prototype tests cannot change that result.

Required matrix: physical Android at effective widths 320/360/393/411 dp, font scales 1/1.3/2, light/dark, TalkBack, keyboard/safe area, supported API/device classes and two independently authenticated devices. Record exact build, device/API, scenario data, observed result, evidence path and defect before assigning PASS. No personal evidence or full identifiers in the public packet.

| ID | Scenario | Status | Required evidence |
| --- | --- | --- | --- |
| A01 | Fresh seller, manual start without marketplace | NOT RUN | Unassisted start recording and tap count |
| A02 | Normal manual packing to authoritative finish | NOT RUN | Continuous physical take, review/sign, server manifest |
| A03 | Actual policy requires supplemental photos | NOT RUN | Policy fixture and stage-specific required views |
| A04 | Same incomplete Proof from four entries | NOT RUN | Home/list/notification/deep-link equivalence |
| A05 | Finalized Proof viewer | NOT RUN | No illegal capture action; correct manifest/share |
| A06 | Empty imported-order queue | NOT RUN | No useless filters/search; manual start visible |
| A07 | Large order queue | NOT RUN | Filters/scroll/sort/search and last chip accessible |
| A08 | Known/unknown scan and permission denial | NOT RUN | Exact resolution/fallback, no duplicate transaction |
| A09 | Optional tracking absent/present | NOT RUN | Source provenance, seller gate, no finalization effect |
| A10 | Two-event history | NOT RUN | Compact timestamps and full detail access |
| A11 | Buyer/receiver invitation | NOT RUN | Authorized fields/actions only, server rejection test |
| A12 | Themes/settings/profile | NOT RUN | Same hierarchy and all account functions reachable |
| A13 | Optional capture receipt | NOT RUN | Advanced discovery, explicit consent, intact functionality |
| A14 | Handoff after appropriate stage | NOT RUN | Correct next step and no carrier-acceptance claim |
| A15 | Mixed tasks and counterparty waiting | NOT RUN | Own-action ranking and deduplicated hero |
| B01 | Offline before upload and later online | NOT RUN | Durable original and same-job resumed transfer |
| B02 | Force-stop during/after file save | NOT RUN | Exact recoverability and interrupted-take distinction |
| B03 | Auth/upload token expiration | NOT RUN | Same account/job, no duplicate or privacy leak |
| B04 | Double submit, timeout, retry | NOT RUN | Idempotent server operation and reservation |
| B05 | Hash/declaration rejection | NOT RUN | No success, original retained, exact recovery |
| B06 | Other-device finalization | NOT RUN | Fresh authoritative state, no illegal overwrite |
| B07 | Account switch with pending local media | NOT RUN | No cross-account file display/attachment |
| B08 | Storage exhaustion/camera denied | NOT RUN | Recoverable preflight; no false saved state |
| B09 | Android Back/background during recording/review | NOT RUN | No silent loss; guarded truthful transition |
| B10 | Seller/counterparty-stage lifecycle | NOT RUN | Correct roles/declarations and server permission |
| B11 | Width/font/theme matrix | NOT RUN | Actual screenshots, no essential control clipping |
| B12 | TalkBack and switch/keyboard | NOT RUN | Focus order, labels, announcements, 48 dp targets |
| B13 | Long and mixed-direction titles/locale times | NOT RUN | Wrapping/accessibility and safe identity display |
| B14 | Slow/offline/loading/error/zero events | NOT RUN | Bounded recoverable states, honest status |
| B15 | Presentation rollback with pending original | NOT RUN | Same journal survives; supported old/new schema |

## G3 usability

Recruit five target users unfamiliar with PackProof, with consent, using synthetic fixtures. Observe manual start, capture/review, saved-vs-finalized comprehension, unfinished Proof and optional tracking without coaching. Proposed gates from the plan: 5/5 find manual start within 15 seconds; at least 4/5 complete first journey unassisted; 5/5 explain status truth; no unresolved safety defect. These are targets, not measured outcomes.

## Release decision

An internal build and recorded task flow are required for G2. G3 needs physical-device accessibility/recovery and usability evidence. G4 requires explicit founder approval of the exact build. No store or public deployment should be inferred from G1 design approval.
