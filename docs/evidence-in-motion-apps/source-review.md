# Independent implementation source review

Reviewed October 24, 2026 against the attached Evidence in Motion plan and inherited SIGNAL acceptance obligations. Snapshot: uncommitted candidate over upstream b08daf7982bedb6916702b5e4ee237a314f726da; local reconstruction da5feca is not upstream provenance. This is a source review, not a real capture, installed visual or release acceptance result.

## Concrete findings and follow-through

| Finding | Observed candidate code | Required repair / current disposition |
| --- | --- | --- |
| False local-retention promise | Shared web SignalProgress asserted original retained/on device regardless of actual availability; desktop also called it with missing job or unavailable local copy. Native submission catch asserted retained even when localFileAvailable was false. | Owners notified. Web source now accepts explicit true/false/unknown availability; native and desktop callers/error paths require actual-state binding and affected checks. Until gathered results, this is not accepted. |
| Wrong dominant next task | Web MobileHomeScreen chose the first accepted pending recording and made passive transfer progress primary even when the shared ranked recommendation targeted urgent work on another Proof. | Web owner notified to bind primary action/featured identity to the ranked recommendation and keep passive transfer secondary. Verify with concurrent-record scenario and tap-time revalidation. |
| Chronology time and source substitution | Desktop SignalSourceChronology sorted raw timestamp strings and fell back to first event if selected identity disappeared. Different offsets can be ordered incorrectly and an inspector can silently change source. | Shared owner notified to sort parsed instants with deterministic fallback, preserve unavailable selection explicitly and expose deliberate reset. Native/web use parsed-time selectors. |
| Token authority incomplete | EIM role values were duplicated across native source, web variable assignments and desktop CSS without a canonical versioned source/generator drift gate. | Shared owner implementing a versioned token package/export and consumer checks. Mark WP02 incomplete until actual source and output validation are attached. |
| Native display differs from contract | Figma contract specifies 40/44 Inter ExtraBold; inspected native display/receipt used 38/44 Inter-Bold700, and only regular/semibold/bold were registered. | Genuine Medium/ExtraBold asset and correct registration requested; do not synthesize 800 with a 700 face. Requires equivalent-size installed screenshot comparison. |

## Preserved boundaries observed

The reviewed changes compose presentation around existing queue/provider/capture and canonical receipt owners. No new uploader, screen-owned finalization, privileged desktop bridge expansion or backend evidence mutation appeared in the changed files inspected. Matching canonical receipt predicates continue to gate positive saved treatment. This narrower source observation does not prove every runtime state or guarantee.

Native route ownership is scoped by API/account/Proof. Web ProofScreen keys WorkspaceProofRecord by Proof/account/recovery scope; native connected record keys its content by API/account/Proof. Existing original playback components remain in use. Source identity, timestamps and participant/carrier limitations are explicit in new inspectors.

## Remaining acceptance obligations

Verify all applicable inherited and production states, every visible control and large chronology behavior with real owners. In particular, source code alone cannot establish physical interruption/recovery, promised local-file survival, same-operation upload reconciliation, fresh canonical receipt, account isolation, old-to-new pending-work upgrade, actual rollback or signed store artifact identity. ADB daemon startup failure leaves those physical scenarios Not executed.

Visual contract completion, runtime fidelity, automated build/checks and publication are separate facts. Open findings should be updated with the actual repair paths, candidate SHA and affected check evidence; do not erase this review history to imply the defect never existed.
## Follow-through checkpoint

Subsequent source inspection confirms these repairs are now present, with final affected output review still pending:

- Web SignalProgress distinguishes actual available, unavailable and unknown local originals; web Home has a two-Proof urgent-recovery priority regression test and routes the ranked task through its existing validated command path. Hosted reconciliation must carry the same fixes.
- Desktop source-chronology.ts compares parsed instants, preserves unknown-time meaning and returns no selected event for a disappeared ID; selection now requires a deliberate event/reset action.
- Canonical version 1.0.0 token source is present at packages/evidence-in-motion/tokens.v1.json with generate-tokens.mjs and generated TypeScript/CSS outputs. Inspect actual --check output before closing the drift gate.
- Native display dimensions were corrected to 40/44. At that interim checkpoint, genuine native ExtraBold/Medium availability was pending; the final follow-through below records the supplied and validated fonts. Installed font fidelity remains open.

The native server-confirmation error message was rechecked and still required actual local-availability wording at this checkpoint; its owner was notified again. None of these source findings closes physical, visual or publication acceptance.

Native confirmation-error repair is now present: retained/unavailable/unknown messages depend on actual localFileAvailable and update when it changes. The owner retained the existing receipt predicate. Actual saved output confirms 61 focused tests passed and 12 changed UI files had no syntax errors. These remain local checks; cleanup/restart/receipt races are not claimed as physical integration passes.

## Final review follow-through

The previously reported source defects now have concrete repairs and saved focused evidence:

- Retention messages use actual true/false/unknown local availability in shared web/desktop and native submission views. The new native pure submission projection also distinguishes queued, confirmation-needed and exact-operation transport progress; matching recovery/sign-in commands remain with current owners.
- Ranked web Home recovery takes priority over another Proof's passive upload; the rendered two-Proof regression is included in final focused web evidence.
- Desktop chronology compares actual instants, preserves unknown dates and unavailable selected IDs, and requires deliberate selection/reset. Current backend chronology association and account guards were refined in native selectors.
- Canonical tokens.v1.json plus generated TypeScript/CSS and consumer/output drift checking replace competing shell-role values. Saved v1.0.0 drift output passed.
- Genuine Inter Medium 500 and ExtraBold 800 files are registered, with five-weight font checks passed. Native display/receipt is 40/44/800 and secondary 14/20/500; desktop display is 48/52/800. Actual native rendering remains unreviewed.
- Final native compiler output now has zero full-project diagnostics; the initial import-extension error is preserved separately. Exact web installation now uses declared Vite/Vitest versions; final build and 28 focused checks passed. Earlier cached results are historical, not final release evidence.

Browser review inspected actual component-gallery sizes 390x844 and 1280x720, correcting heading cascade, gutters, link chrome and receipt wrapping. It confirmed source-inspector identity, light/dark composition and Motion Off. Synthetic fixtures and no camera/server journey mean this does not close real end-to-end, all-state visual or native acceptance. Final candidate SHA/remote CI, phone recovery/upgrade, signed platform packages and publication remain pending.


## Hosted integration at final source freeze

The actual hosted source baseline is 5b454f836872cc9292b4b12fc4709674bb5c2d37 (live version 62), separate from GitHub. Its newer public library, authentication, fixed API bridge, grading/export paths and route guards were retained. The EIM/SIGNAL presentation adapters were merged around these owners rather than replacing the hosted repository with the GitHub snapshot.

The corrected hosted production build passed TypeScript, Vite, Evidence Library generation (16 articles, 7 topics and 16 prerendered public pages), and Worker compilation. Fourteen publication/bridge/association/routing checks passed. Source-linked chronology fixes were ported to both trees and focused record tests passed. These are candidate checks, not production publication or a real camera journey.

At the inspected 1280px gallery width, source details expand inline within the chronology column. The plan's adjacent desktop inspector treatment still needs fidelity review. Other remaining visual/device limits are listed in browser-and-release-review.json. No unsupported screenshot or physical-device acceptance is asserted.
