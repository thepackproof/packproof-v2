# Custody workflow (grading vertical slice)

This is an additive extension of the existing Proof core. It does not replace Proof status, evidence commit, participants, or `COMMERCE_SALE` fulfillment.

Internal model (not user-facing):

- **Asset** — a specific physical item on a Proof (`proof_assets`). PackProof generates `asset_instance_id`. Users see Item 1, Item 2.
- **Observation** — an append-only record of assets at a workflow moment (`custody_observations`), bound only to **committed** same-Proof evidence.
- **Transfer** — the interval between observations (`custody_transfers`). One endpoint may be missing; that is a first-class gap, not a failure of the other party.

Auth primitives remain `SELLER` and `BUYER`. Grading presents them as Originator and Receiving participant.

## Workflow types

`proofs.workflow_type` is immutable after insert. Existing Proofs default to `COMMERCE_SALE`.

| Type | Meaning |
| --- | --- |
| `COMMERCE_SALE` | Existing sale/fulfillment path. Packing evidence stays `FULFILLMENT_CAPTURE`. |
| `GRADING_SUBMISSION` | Document items → pack → hand off → receive → compare → optional return → finalize. |

Clients never write Proof status. The server derives `workflowStage` and `nextAction` from stored facts.

Example `nextAction`:

```json
{
  "type": "CAPTURE_ASSET",
  "assetId": "asset_…",
  "title": "Document item 1 of 2",
  "hint": "Capture the front and back of this item.",
  "captureRecipe": "CARD_STANDARD_V1",
  "actorRole": "SELLER"
}
```

Action types: `CAPTURE_ASSET`, `PACK_ITEMS`, `HAND_OFF`, `WAIT_FOR_RECEIPT`, `RECEIVE_ITEMS`, `COMPARE`, `DOCUMENT_OUTPUT`, `RETURN_PACK`, `FINAL_RECEIPT`, `FINALIZE`, `COMPLETE`.

## Capture recipes

Recipes describe required slots. They do not create a second evidence store.

| Recipe | Evidence type | Required slots |
| --- | --- | --- |
| `CARD_STANDARD_V1` | `ASSET_CAPTURE` | FRONT, BACK |
| `PACKING_STANDARD_V1` | `PACKING_CAPTURE` | PACKING_VIDEO |
| `RECEIPT_STANDARD_V1` | `RECEIPT_CAPTURE` | PACKAGE, ITEM_FRONT, ITEM_BACK |

Commerce packing must keep `FULFILLMENT_CAPTURE` even if a packing recipe is shown. Grading packing uses `PACKING_CAPTURE`.

## Orchestration

Generic commands (not `/grading/*`):

```text
POST /proofs
POST /proofs/:id/assets
GET  /proofs/:id/assets
GET  /proofs/:id/evidence/:evidenceId
POST /proofs/:id/actions/document
POST /proofs/:id/actions/pack
POST /proofs/:id/actions/handoff
POST /proofs/:id/actions/receive
POST /proofs/:id/actions/compare
POST /proofs/:id/actions/output
POST /proofs/:id/actions/return-pack
POST /proofs/:id/actions/final-receipt
```

Handoff opens a transfer. Receive closes it. Compare writes a versioned continuity row; it never mutates source evidence.

Continuity vocabulary: `NOT_EVALUATED`, `CONSISTENT`, `INCONCLUSIVE`, `MATERIAL_DIFFERENCE`.

Safe summaries:

- Evidence at the receiving observation contains a material visual difference from the origin observation.
- The available observations are materially consistent.
- No PackProof observation exists for this interval.

Do not say chain of custody failed, the grader swapped the card, or PackProof guarantees this is the same item.

## Guest viewing links

```text
POST   /proofs/:id/access-links
GET    /proofs/:id/access-links
DELETE /proofs/:id/access-links/:linkId
GET    /public/proofs/:token
```

Web path: `/p/:token`. Guest projection schema: `packproof.proof.public/v1`.

- Raw token is returned once on create and is stored as SHA-256.
- List endpoints never include the token.
- Invalid, expired, or revoked tokens fail closed (404-style).
- Guests cannot mutate. Join is a read-only CTA; participation still uses invitation + accept.
- First successful view may append `PROOF_VIEWED_VIA_ACCESS_LINK` once. Status-page refreshes must not flood audit.

## Finalization compatibility

Commerce manifests do not gain custody keys unless the Proof is not `COMMERCE_SALE` or custody observations exist.

After `FINALIZED`, custody mutation is rejected. Deterministic SHA-256 of the canonical JSON remains the integrity seal.

## Migration

`backend/migrations/016_custody_workflow.sql` adds `workflow_type`, custody tables, and extends `evidence_type_check` with `ASSET_CAPTURE`, `PACKING_CAPTURE`, `RECEIPT_CAPTURE`.

## Ordinary presentation

Users see Documented, Packed, Handed off, Received, Returned. SHA-256, evidence ids, observation ids, and algorithm versions stay under Technical details.
