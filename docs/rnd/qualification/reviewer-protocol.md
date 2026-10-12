# F03-06 and F05-06 reviewer study readiness

The offline toolkit is ready to assign and score a controlled study. **No real reviewers, reference annotations or physical study outcomes have been collected by this work.** It does not change the qualification or release status of either feature.

Use [reviewer-toolkit.md](reviewer-toolkit.md) for commands, formats and metric definitions. All sources, observations and limitations remain attributed. The study never asks reviewers to decide fraud, authenticity, custody, responsibility or a claim outcome.

## What the implemented study compares

Each reviewer receives one presentation of each case: original sources alone, or the same originals plus the frozen research enrichment. The program balances both conditions within each feature/stratum for every reviewer, and assigns equal numbers of reviewers to each condition for each case. Order is separately randomized. A reviewer never sees both versions of a case. The tool rejects repeated source, session or specimen groups across test cases, avoiding direct recognition of the same case in another presentation.

Reference answers, scenario labels, original filenames, the assignment key and the private seed are omitted from reviewer packets. This is **outcome and scenario blinding**, not a double-blind intervention: reviewers can see when enrichment is present. Images, video, text and derived artifacts require a separate privacy and blinding inspection because their bytes may contain labels or identities. The toolkit preserves exact supplied bytes; it does not silently redact or edit them.

The software uses blocked assignment and reports completion, errors and time separately. These choices follow the experimental-design and usability measurement concepts in the [NIST randomized-block guidance](https://www.itl.nist.gov/div898/handbook/pri/section3/pri332.htm) and [NIST usability-testing guidance](https://www.nist.gov/programs-projects/usability-testing). Those sources do not supply a PackProof sample size or passing threshold. The allocations below are proposals for planning, not achieved qualification or statistically justified final sample sizes.

## F03-06: source-linked event review

Ask a narrow question such as: “Locate the visible `ITEM_CROSSES_OPENING` event in the supplied original recording.” Use only the event vocabulary already supported by the research annotation protocol. An OBSERVED response must identify the original source and event start/end in milliseconds. NOT_OBSERVED concerns this supplied recording only; NOT_ASSESSABLE is appropriate for an obscured, absent or otherwise insufficient view. Neither response establishes off-camera events or physical continuity.

Reference annotators inspect originals without model predictions. Each records exact source SHA-256, event class, decoder/version, source interval, ambiguity and conflicting observations. Freeze acceptable intervals and the event-boundary tolerance using a separate training/tuning set before exposing the test set. The demonstration's 250 ms tolerance is a software fixture, not a recommended physical threshold. Recording-interruption reference annotations require the corresponding committed journal; a gap between sampled images must not become an invented stop event.

Provisional feasibility allocation: **24 independent held-out cases and 12 reviewers**, yielding 288 assignments, six reviewers per case per condition. Suggest four cases in each of six prespecified strata: clearly visible ordinary action, temporary occlusion, off-camera or sampling gap, visually similar items, source/journal-supported interruption, and ambiguous or absent event. Select and freeze the event-class mix explicitly; this screening allocation cannot establish per-class accuracy for all ten event types. Two practice tasks per reviewer use separate specimens/sessions/sources and are not part of the scored assignments.

Collect time to a correct source/interval response, assigned-task reference agreement, abstention/failure/no-response rates, conflict detection and categorical inter-reviewer agreement. Do not claim accelerated review from the median time of successes alone. The output also reports the prespecified time limit as a penalty for unsuccessful scorable assignments. Choose the limit before testing; an initial planning allowance of three minutes per task may be revised from a separate practice pilot before freezing the real study.

## F05-06: descriptive channel comparison and confidence calibration

Use paired lifecycle sources with their distinct package subjects retained. Ask one fixed channel question per case: identifier, tracking, weight, appearance, surface, condition or provenance. Responses describe recorded values or information: OBSERVED_VALUES_EQUAL, OBSERVED_VALUES_DIFFER, MISSING_VALUE, CONFLICTING_VALUES or INCONCLUSIVE. Literal text equality does not establish physical identity. Reported mass does not establish calibrated metrology, and a missing recipient or source is not evidence of agreement.

Provisional feasibility allocation: **24 independent held-out paired cases and 12 reviewers**, again 288 assignments. Suggest four cases in each requested scenario family: same-SKU substitution, copied serial text, partial return, new carton, legitimate repair, and absent recipient/source. These scenario labels remain coordinator-only. Reference answers concern the visible/source-attributed observations, not whether a scenario is wrongful. Freeze channel allocation and include both missing and conflicting observations; 24 cases cannot establish rare-error bounds or complete seven-channel calibration.

The questionnaire requests confidence in agreement with an independent observational annotation, not confidence in product identity or a claim outcome. The scorer reports Brier error and fixed confidence-bin agreement **only for completed responses with resolved references**, alongside that denominator and all incomplete assignments. These are descriptive reviewer-answer calibration measures. They do not calibrate PackProof's physical correspondence claims or approve a machine confidence score. A five-minute planning allowance per matrix case is provisional and must be frozen after separate practice work.

Use different specimen/source clusters for F03 and F05. If the same 12 reviewers participate in both, separate sessions and counterbalance which study comes first outside the current toolkit; record that allocation. Alternatively use two separate 12-person cohorts. Final confirmatory sample size needs a prespecified smallest meaningful difference and variance estimates for both reviewers and cases, including attrition. A statistician should select a crossed reviewer/case analysis before confirmatory data access. The software deliberately emits no independent-assignment significance test or qualification threshold.

## Reference preparation and disagreements

1. Two independent annotators inspect every test case without enrichment or study responses. Record their annotations in the private [annotation template](reviewer-reference.template.csv). They must not be among the blinded study reviewers for those cases.
2. A third annotation reviewer checks disagreements against the originals. Preserve both initial records and the review reason; do not erase an annotation to improve agreement. Create a frozen reference artifact and place its exact SHA-256 in each case's `annotationDigest`.
3. Mark unresolved references DISPUTED. The program retains every assigned task and reports the disputed-reference population separately, excluding it from reference-based correctness and calibration. It does not automatically choose a winner.
4. Keep source bytes, recipe/model hashes, enrichment bytes, exact input manifest and policy digest in the authorized private study record. Independent annotation and consent are facts requiring coordinator review; a hash or checkbox cannot establish them.

## Execution protocol

1. Prespecify task questions, strata, endpoint definitions, duration limits, event tolerance, inclusion/exclusion rules, accommodations, interruption handling and the analysis plan. Freeze source/specimen splits and input hashes before review. Keep train/tune/practice material distinct from test material.
2. Obtain the required consent and study authorization, then build packets locally. The roster should contain pseudonymous local participant codes and suitability/consent references; keep contact identities in a separate protected system. Assign people to packet tokens randomly before inspecting outcomes.
3. Independently audit the two conditions for each case: same original bytes, correct enrichment version and no answer key, scenario or personal information leaked through asset contents. Verify the assignment counts in the private key. Save the preparation receipt before distribution.
4. Give each reviewer **only their own packet directory**, not the parent study directory, coordinator key or other reviewers' packets. Run the practice tasks, then open `review.html` in the agreed browser. Do not coach event or matrix answers. The page requires explicit task start, applies the frozen deadline and downloads cumulative responses after each task.
5. Confirm each download exists. Retain only the final cumulative response file per packet as scoring input, preserving earlier versions in the private audit record. Do not silently merge duplicate submissions; the scorer rejects duplicate assignment IDs. Restarted or interrupted sessions must be logged, not reconstructed from memory as uninterrupted timing.
6. Record technical failures, abstentions and accommodations in the private [deviation log](reviewer-deviations.template.csv). A technical failure is a study observation. An unreturned packet still contributes NO_RESPONSE to all assigned tasks.
7. Score without editing the frozen key. Archive inputs, response-file hashes and output. Report all assignments, all failures/abstentions/disputed references, per-stratum results and protocol deviations. Preserve null metrics when no scorable responses exist.
8. Have the independent study lead review the evidence before any product decision. This toolkit never sets `qualified` or `releaseAuthorized` to true.

## Exact inputs still needed from the user or study owner

| Input | Concrete requirement | Why the toolkit cannot provide it |
|---|---|---|
| Study authority | Named study owner, approved observational protocol, permitted use/retention/access scope | Software cannot authorize people or data use |
| Real cases | Consented original recordings and any committed journals; paired lifecycle sources for F05; exact source SHA-256 and specimen/session lineage | No real case has been acquired here |
| Frozen enrichment | Exact exported research artifacts and their source/method/model/recipe commitments for each original case | Synthetic examples do not validate the real treatment |
| Independent annotations | Two annotators plus one disagreement reviewer; source-linked records and frozen annotation artifact hashes | Model output cannot be its own independent reference |
| Blinded participants | A recruited, consenting cohort representing intended reviewers; initial proposal 12 per study, with experience/accessibility context recorded privately | No people were contacted or consented |
| Test setting | Supported review workstation/browser, video playback check, accommodations, session schedule and interruption logging | No installed or human usability acceptance is inferred |
| Confirmatory design | Reviewed effect size, clustered/crossed analysis and justified sample size after a separate feasibility pilot | Proposed 24-case/12-reviewer allocations are not qualification thresholds |

There is no need to send customer identities or credentials to this toolkit. Provide authorized pseudonymous artifacts and retain identity/contact mappings with the study owner.
