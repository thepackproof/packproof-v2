# Recipient export profile review - 22 October 2026

The September profiles expired on 7 October. New requests must use a newly reviewed identity; existing request and artifact snapshots retain their original profile and approval hash. Version `2026-10-22.1` adds `-v2` identities, effective 22 October through 20 November. The service rejects them before their effective date and from 21 November onward. Web and Android already select a currently reviewed profile from the service response, so no capture or navigation change is needed.

| Destination | Current official constraint | Reviewed implementation |
| --- | --- | --- |
| eBay payment dispute | JPEG/JPG/PNG, up to five files, combined size strictly below 1.75 MB | JPEG/PNG, five files/pages, less than 1,750,000 encoded bytes; conservative target 1,600,000 bytes |
| Stripe dispute | Combined files at most 4.5 MB; Mastercard combined maximum 19 pages; one file per evidence type | One PDF/JPEG/PNG packet, at most 4,500,000 bytes and 19 pages; conservative target 4,000,000 bytes |

The non-Mastercard 19-page cap is a conservative PackProof product limit. It is not presented as a universal network rule. Existing output rendering and byte/magic/legibility validation remain in place. A profile review does not establish acceptance by a live provider portal.

Stripe states that reviewers do not review external audio/video or links, so the export keeps relevant source-linked stills and concise facts in the files themselves. Multiple disputes can relate to one payment; the forthcoming ClaimCase identity must include provider, provider account and dispute ID. Exporting or approving files does not submit evidence, acknowledge receipt, or determine an outcome. Deadlines must come from the actual case; generic response windows are not substituted.

Primary sources read on 22 October 2026:

- [Stripe: Respond to disputes](https://docs.stripe.com/disputes/responding), supporting-file and final-submission guidance.
- [eBay: Handling payment disputes](https://www.ebay.com/help/selling/getting-paid/handling-payment-disputes?id=4799), evidence formats, total bytes and file count.

Focused checks cover historical profile preservation, no silent identity replacement, future/expired profile denial, the current profile list and strict byte/page/file boundaries. Deterministic provider/account/dispute identity, reason-specific selection and exact-package approval binding still require the remaining M2-04 implementation. No external provider was contacted or supplied with evidence by these changes.
