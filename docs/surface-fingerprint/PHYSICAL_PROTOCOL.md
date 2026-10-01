# Physical validation protocol — no collected results

Owner and independent reviewer are unassigned. This document specifies work still required; blank templates are not a completed corpus. The research worker's synthetic fixtures must never be imported into a physical performance report.

## Screening corpus

Create 240 distinct physical labels: four processes × three media lots × two identical-content designs × ten independently printed copies. Use more than one printer unit per process and distribute copies across units and printing sessions. Record direct thermal separately from thermal transfer, laser and inkjet. Record actual lot identity; do not assign a fictional lot to satisfy a matrix.

Collect 60 distinct carton surfaces across three ordinary material classes, including new and reused examples. Build same-label/new-carton and same-carton/new-label assemblies. Ordinary marker on carton is an internal comparator only; never a required merchant step.

Assign separate IDs for physical print, paper substrate, carton, region, assembly state, shipment leg and closure/contents scenario. Administrative labels must stay outside matching crops. Transferred genuine labels are positive for same-label and negative for same-assembly ground truth.

## Capture sequence

1. Freeze app/native/extractor/policy builds and record hashes. Record OS, lens, native stream configuration, dimensions, frame rate, codec, compression, orientation and unavailable metadata as null.
2. Record feature-off controls and ordinary packing runs. Do not coach the operator to pause or add a photograph. Capture full attempt denominators, automatic sidecar availability, time and continuity. Test both S24 Ultra→A16 and A16→S24 Ultra directions.
3. Repeat with different operators, days, lighting, distance and motion. Separately label diagnostic close-ups. Coached close-ups cannot satisfy passive enrollment gates.
4. Use known-size laboratory targets to measure sampled detail and optical loss in the actual capture stream. Barcode readability and digital zoom are not evidence of physical detail.
5. Repeat on an independent Android family and physical iPhones. Document unsupported combinations rather than forcing successful inputs.
6. Retain selected originals, video context and native timing; hash at collection and verify after upload. Capture device wall time, monotonic time and server receipt independently.

## Split and blinding

All frames/crops for a physical object stay in a single split. Design leakage and held-out domains explicitly across print design, printer unit, lot, operator, session and device family. Overlapping IDs must fail the corpus validator. The independent reviewer controls the blind test labels; developers freeze settings and hashes before receiving final results. Keep a small development/golden regression set separate from the locked blind set.

Benchmark barcode-only, layout-only, print-residual, substrate-only, relationship-only, multi-frame and complete configurations. Correlated comparisons may explore score distributions but must not be counted as independent physical trials. Report genuine errors, false consistency, abstentions, failure to enroll, whole-flow success, retries, latency and added operator time by profile and attack family.

## Robustness and attack matrix

Expand to at least 1,000 distinct parcel assemblies for engineering coverage; that count alone does not establish the rare-error gate. Include actual shipment and real aging over the proposed support period. Ordinary safe handling is not formal transport certification.

| Family | Required variants | Correct evaluation scope |
| --- | --- | --- |
| Wear | Scuff, fold, dirt, moisture/drying, compression, heat/light, aging | Genuine identity, damaged region and coverage separately |
| Label replacement | Legitimate reprint; identical-content physical copy | Same transaction, different physical print |
| Replay | Phone/tablet screen, printed photograph, different reproduction quality | Physical nonmatch even when capture is live |
| Transfer | Genuine label onto another carton, label+surrounding patch transplant | Label identity and assembly outcome independently |
| Occlusion | One or all required carton regions hidden; over-tape/glare | Missing required scope must abstain |
| Reopening | Original package opened through unobserved panel and reclosed | Matching observed surfaces cannot certify closure |
| Domain holdout | Unseen device, printer, media, mailer or age | Unsupported rejection, never silent extrapolation |
| Digital substitution | Old intent, replaced media/template, changed package/leg or actor | Reject binding/bytes before physical decision |

## Gate record

Each record must contain protocol version, evaluator, independent reviewer, frozen build and policy digests, test-set digest, number of physical instances, sampling/dependence assumptions, complete denominators, per-profile results, uncertainty, exclusions, unresolved attacks, allowed claims and explicit decision. Missing required evidence means `NOT_ESTABLISHED`, not pass. See `templates/gate-record.json`.
