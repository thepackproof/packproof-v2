# Proof simplification — 6 September 2026

The previous Proof view exposed too many tools, repeated empty states, and competing actions. Sharing also asked people to choose between buyer and claims versions of the same transaction.

## Experience

- Default to a light neutral theme with charcoal text and restrained green actions. Explicit appearance preferences remain supported.
- Keep the item header compact, with Recording, Activity, and Tracking tabs and one state-appropriate next action.
- Put supporting evidence, case, comparison, privacy-copy, and technical tools behind More. Keep receipt and return documentation available for finalized transactions.
- Show meaningful milestones first. Detailed access history remains available on demand.
- Use one short tracking empty state and include committed receipt and return recordings alongside packing evidence.
- Keep native content and fixed actions within Android safe areas.
- Use one shared Proof with the same committed originals, activity, and shipment status for every new link. The share flow contains a preview, expiry, and explicit share action; there is no audience or field-selection variant.

## Sharing contract

`POST /proofs/:id/disclosure/preview` accepts `{ "purpose": "SHARED_PROOF" }`. The server derives the fixed shared projection and committed media sources.

`POST /proofs/:id/disclosure/grants` accepts the same purpose plus `originalsReviewed: true`, the exact `previewHash`, and `expiresAt`. Creating a link requires an explicit review action. New active links show future committed updates to the same Proof. The preview explains that original recordings and future updates are shared and asks the owner to check recordings for private information.

Legacy scoped links keep their existing permissions. Link expiry and revocation still apply, including while media is being read. Original content remains integrity-checked and bound to its Proof. Finalized core manifests and append-only evidence rules are unchanged.

## Release order

Deploy the backend with additive migration `033_shared_proof.sql` before rolling out the new web or Android clients. Older backends do not accept the new sharing purpose. Preserve existing runtime settings when deploying. Android candidate: version 0.3.4, version code 33, `shipping-integration` profile.

## Validation

- Backend: 470 tests passed; seven environment-dependent tests skipped locally.
- Web: all 105 tests passed, including one-proof review/create, expiry, stage playback, activity filtering, and revocation recovery.
- Web and backend production builds passed.
- Mobile: TypeScript check, Proof/Tracking tests, native API sharing contract test, and theme/contrast tests passed.
- No physical Android device or browser visual acceptance test was performed in this implementation pass.

Code and build preparation do not themselves deploy the backend, publish the existing Site, or release the app through Google Play.
