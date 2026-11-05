# Quantity assertions, immutable requirements and review routing

Quantity inputs are source assertions. Supply separate system, reference and source-reported timestamp values. Optional payloadSha256 is the caller's declared source digest; verified original-file preservation uses the source-artifact intake separately. A quantity match, signature or file digest does not establish physical condition.

## Typed entity attributes

Use attributes.quantityComparison with schema packproof.quantity-comparison/v1, expected and observed assertions, and optional tolerance. Each assertion contains quantity {amount, unit} and source {system, reference, reportedAt, payloadSha256?}. Amounts are nonnegative decimal strings: twelve whole digits and nine fractional digits maximum; no exponent, locale or floating-point inference.

Use attributes.itemAllocation only on an item entity, with schema packproof.item-allocation/v1, optional sku/description, an ordered assertion and allocations. Each allocation explicitly names a current same-record package/pallet and contains its own quantity and source. At most fifty unique handling units are accepted per item version within the entity's 8 KiB normalized metadata cap.

The server derives evaluation; callers cannot supply or rewrite that field. Corrections append a new same-kind entity with supersedesId and reason; the original remains preserved. A current version can have only one subsequent correction through the revision-protected command path.

| Dimension | Supported units | Base |
| --- | --- | --- |
| Count | each, dozen | each |
| Mass | kg, g, lb, oz (avoirdupois) | kg |
| Length | m, cm, mm, in, ft | m |
| Volume | L, mL | L |

Conversions and differences use exact rational arithmetic. The allowed difference is the greater of the explicit absolute tolerance and expected quantity multiplied by relativePpm/1,000,000. The boundary is inclusive. Default tolerance is zero. Unknown units, different dimensions and incompatible tolerance units produce not_comparable, never a guessed pass. Product-specific pack sizes require an explicit source-qualified mapping; volume is not converted to mass.

Mismatch/non-comparable evaluations append source-attributed issues. They do not change ordered quantities or automatically resolve earlier issues. The operational manifest freezes the asserted facts, rule identity and resulting issue metadata; a live portal view remains separate from a historical package.

Exact reference matching searches current, authorized entities in one record. Multiple results return ambiguous with automaticMatch:null; it never chooses the first candidate silently. More than ten matches are explicitly truncated with hasMore:true.

## Requirements

A current human OWNER/ADMIN publishes an immutable template version. Each rule has a unique key, shipping stage, title, supported evidence categories and bounded grace period. The catalog is limited to 500 versions per organization/environment and twenty rules per version. Publishing a later version does not alter existing assignments.

Assignment requires current record revision, stable command key, exact version/digest, known same-record subject and a reason. A due time must include its time zone. All rules are created transactionally; a failed or duplicate assignment cannot leave partial requirements. Definitions and assignments are reconstructable through the policy/core journals. Waivers retain their separate administrator-only route and reason.

## Review responsibility

Human administrators, or services explicitly granted issues:assign plus proofs:write, can assign an eligible current member. A member's current record/location access is verified at admission. Assignment does not grant access; subsequent revocation stays effective.

Routing appends immutable history and a review note that is included in operational snapshot actions. It does not mark the issue resolved or attest as the recipient. The latest assignment reports membershipActive, which describes membership revocation state, not a promise of future access. Explicit clearing retains earlier assignments and reasons. Candidate lookup checks at most 200 active memberships; an issue retains up to 500 routing actions.
