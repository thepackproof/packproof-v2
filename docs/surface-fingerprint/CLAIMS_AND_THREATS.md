# Claim and threat matrix

## Claims

| Evidence | Permitted statement after qualification | Never implies |
| --- | --- | --- |
| Tracking/barcode | Identifies the expected shipment record | Same physical label or package |
| Print-region comparison | These observed print regions are consistent/different under the named profile | All labels with the same content are genuine; a probability of fraud |
| Label-paper comparison | These observed substrate regions are consistent/different | Same carton, unbroken closure or contents |
| Carton-region comparison | These observed carton regions are consistent/different | Unobserved carton panels or opening paths are unchanged |
| Label/carton relationship | Required observed regions and placement are consistent within the frozen coverage policy | Whole-package authentication or tamper-proofing |
| SHA-256 digest | Exact retained bytes match a commitment | Two photos depict the same object; scene truth |
| Signed extension | A known issuer committed these exact extension bytes | Capture time is independently witnessed; later extensions do not exist |
| Request/app assurance | Request binding and reported app/device assurance at the stated level | The camera sensor certified the physical scene |

Before qualification all physical channels remain research observations. Users see experimental/unavailable scope and limitations. No overall verified, authentic, fraud, genuine or 99.9% badge is permitted. Similarity is not calibrated probability.

## Threats and required evidence

Assume a dishonest sender, recipient, operator or compromised client, access to high-quality label photographs, knowledge of the algorithm and repeated probing. Private templates reduce disclosure; secrecy is not the matching method's security argument.

| Attack/failure | Required control | Required test / current qualification |
| --- | --- | --- |
| Same-content reprint | Content suppression; same-content physical negatives; process-specific profiles | Independent actual reprints, printers and lots; **not established** |
| Screen or printed-photo replay | Fresh request binding, temporal/context checks, attack-specific abstention | Real screens and prints under live capture; **not established** |
| Genuine label transferred to another carton | Freeze print and carton groups separately; contradiction prevents composite consistency | Same label/new carton and patch transplantation; **not established** |
| Same carton reopened elsewhere | Scope limited to visible regions; retain ordinary closure footage | Underside/other opening path must not imply closure intact; **not established** |
| Old/swapped media | Intent binds actor, Proof, package/leg, enrollment and request; server validates committed source identity/digest | Expired/reused intent, changed request, wrong evidence and returned media tampering |
| Client supplies score or template | Server-authored jobs and private derived artifacts; ignore/reject client match judgments | Forged score/template, mismatched extractor/policy and template substitution |
| Cross-tenant access | Authorize both reference and query; restrict evidence reads and exports | Foreign Proof/enrollment/source/result identifiers and role changes |
| Duplicate delivery/crash | Durable job lease, idempotent identity, append-only result transaction, retry cap | Duplicate delivery, expired lease, crash before/after result persistence |
| Matcher probing | Authorized one-to-one context, rate/cost budgets, attempt audit; no public raw scores | Repeated conflicting submissions and unsuccessful attempts |
| Decoder exploit/resource exhaustion | Byte/pixel/count/timeout bounds; unprivileged isolated worker; no arbitrary URL/path fetch | Malformed images, huge decoded dimensions, timeout and memory pressure |
| Damaged required region | Independent quality mask, frozen coverage, explicit missingness | Obscured carton must not silently degrade to composite consistency |
| Changed export/root | Exact-byte digests; independently pinned root and extension head; authenticated signatures when supplied | Change root, sources, templates, result or chain; truncated/duplicated/reordered extensions |
| Retained hashes but expired originals | Mark originals missing and reproducibility unavailable | Omitted sources must not produce a complete/reproducible report |

All unsuccessful and exceptional attempts need an audit reason. Logs and telemetry must not include address-bearing raw images, credentials, private templates or signed download URLs. Public derivatives must redact addresses without altering original bytes.

## Open deployment security gates

No production assurance claim is made for Play Integrity, App Attest, decoder isolation, live rate-limit tuning or cloud object permissions merely because an adapter/schema exists. They require live-environment evidence. Do not promote fallback development signing, memory stores, locally supplied identity, unverified assurance or synthetic fixtures into production trust.
