# Support matrix and release gates

## Current support

| Surface/configuration | R&D role | Qualified physical result |
| --- | --- | --- |
| Samsung S24 Ultra rear camera | Intended Android collection/diagnostic device | No — physical run pending |
| Samsung A16 5G rear camera | Intended Android collection/diagnostic device | No — physical run pending |
| S24 Ultra → A16 and reverse | Required cross-device enrollment/query pairs | No — both directions pending |
| Independent midrange Android | Required domain-holdout device family | No — device/configuration not selected |
| Physical iPhone | Native adapter collection and independent qualification | No — physical run pending |
| iOS simulator | Compilation, UI and lifecycle plumbing only | Unsupported for optical qualification |
| Browser/webcam | Review/export, separately qualified capture only | No camera configuration qualified |
| Desktop webcam | Review/export, separately qualified capture only | No camera configuration qualified |
| Inkjet / laser / thermal transfer / direct thermal | Separate experimental print profiles | No process/media/lot profile qualified |
| Glossy over-tape, plastic mailer, damaged/aged labels | Unsupported-domain tests | Unsupported until separately qualified |

`qualified-profiles.json` is intentionally empty. Adding a row requires a signed-off evaluation record with capture stream, native dimensions, camera/lens, OS/app builds, compression, process, coating, material, device pair, age/wear range, extractor/scorer/policy digests and gate evidence. Marketing cannot broaden the support matrix beyond these records.

## Frozen proposed requirements (not observed results)

| Metric | Proposed gate | Denominator |
| --- | --- | --- |
| Passive enrollment | ≥95% | All eligible ordinary-workflow attempts; report exclusions separately |
| Intact comparison coverage | ≥95% | Supported intact paired attempts; include abstentions |
| Erroneous difference | ≤1% | Supported intact genuine trials, both among conclusive results and whole flow |
| False consistency | One-sided 95% upper bound ≤0.01% | Prespecified independent nonmatching physical-instance trials |
| Attacks | No unresolved practical repeatable bypass of advertised scope | Report acceptance and abstention per attack family |
| Continuity | No feature-induced evidence loss/interruption in qualification | Feature-on/off paired workflow runs |
| Working memory | Initial incremental target ≤64 MiB | Real-device peak over feature-off control |
| Added media | Initial target ≤8 MB per enrollment or observation | All selected originals and metadata, including retries |
| Worker latency | Initial p95 target ≤5 s after media availability | Documented CPU/runtime, all comparison attempts |
| Unit cost | Initial target ≤$0.01 per enrollment + comparison over retention | Compute, storage, requests, transfer, retries and failed attempts |

Zero failures in N independent Bernoulli trials yield upper bound `1 - 0.05**(1/N)`. Approximately 30,000 independent zero-error trials are required for the 0.01% target. Pairwise reuse of the same physical labels, videos, sessions, printers or lots does not create independent trials. All-zero clustered bootstrap cannot establish a rare-error guarantee. Report uncertainty and actual dependence structure; obtain a validation statistician's sign-off before claiming the rare-error gate.

## Stage records

| Transition | Required evidence | State |
| --- | --- | --- |
| Offline bench → native shadow | Optical feasibility on actual capture stream, same-content negatives, no mandatory seller action | Blocked on real corpus/device work |
| Native shadow → internal comparison | Gate A: cross-phone repeatability and signal beyond layout/barcode/printer; source provenance/recovery | Blocked |
| Internal comparison → opt-in pilot | Frozen profile; blind metrics/attacks; all integrity/security regressions; costs; consent; independent review | Blocked |
| Pilot → limited production | Full declared scope gates; repeated-use utility; comprehension; rollback rehearsal; support registry | Blocked; production not authorized |

The software may be exercised locally with explicit research flags. Customer-visible findings remain disabled even when internal computation runs. A feature kill switch stops optional work and new findings while preserving the standard Proof and existing evidence access.
