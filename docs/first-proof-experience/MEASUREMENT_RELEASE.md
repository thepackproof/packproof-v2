# Measurement follow-up candidate

This follow-up follows the primary first-Proof experience release. Source configuration is an artifact candidate, not evidence of submission, availability or device acceptance.

- Android package: `com.packproof.mobile`; production EAS profile version code **61**. The primary candidate uses 60. Verify the current Play maximum and signing lineage again immediately before publishing. The existing version name and authentication/API environment remain unchanged.
- The mobile first-Proof flag remains explicitly true in the candidate; measurement still requires an existing, current, explicit account/dataset grant. This build does not enable a study dataset.
- iOS profiles remain separate and use their existing signed release procedure. A JavaScript export is not a signed archive or TestFlight submission.
- Backend source inventory: **77** migrations, ending at frozen `076_first_experience_measurement`. The primary compatibility image has 76 source files and accepts only that exact future receipt/checksum. Deploy and verify the primary compatibility image before applying 076; retain its immutable image as rollback target.
- The follow-up build source guard permits only the reviewed 076 delta from that compatible primary source, or an identical 77-file inventory. The read-only database verifier requires all 77 actual receipts. It performs no DDL and does not grant itself owner credentials.
- Public website/desktop publication, production measurement configuration, signed mobile distribution, physical-device and participant acceptance each require their own evidence. See MEASUREMENT.md and the device checklist for the evidence boundaries.

Suggested user-facing release note: “Create your first Proof with simpler setup, a sample record, and clearer recording recovery. This update also improves optional study measurements and keeps desktop drafts ready to resume.”
