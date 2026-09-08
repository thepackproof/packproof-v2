# Proof navigation release — 8 September 2026

Governing specification: `PackProof_Astra_Proof_Navigation_Development_Plan_2026-09-08(1).docx` supplied by Collin. This release consolidates navigation, record presentation, state and sharing. It does not reseed or delete customer records.

## Release status

API revision 19 reached steady state on 8 September 2026 at 18:12 UTC. Website version 16 was published at 18:16 UTC: https://packproof-experience.packproof.chatgpt.site . Signed Android 0.3.10 (39) passed artifact and signature verification and is available at https://expo.dev/accounts/packproof-llc/projects/packproof/builds/5989a187-655e-433c-9579-74d48758070e . The implementation was merged in PR 39. Final CI passed: backend 759, web 198 and mobile 87 tests, plus 12 focused mobile navigation/sharing tests. Physical device acceptance and browser 200% zoom remain unverified. See `release-evidence.json` for exact provenance and limitations.

## Source reconciliation

The live Sites checkout was `3ac0857a99ed3f01156687dc429b866dd09d148a`. Its backend/mobile code predates the signed Android 0.3.9 (38) candidate. The product implementation is therefore based on `5476459adf057480491639badb15947dae06a43c`, retaining that candidate's camera, barcode, attestation, recovery, imported-field protection and account changes. The later approved website iconography is retained and prepared as clean paper-and-ink assets.

This distinction matters: an updated website alone would leave the newer Android behavior paired with an older API. Backend compatibility is checked before client publication.

## Actual implementation map

| Responsibility | Source | Replacement or retained boundary |
| --- | --- | --- |
| Web route dispatcher | `web/src/App.tsx` | Proofs default; selected Proof remains addressable |
| Web navigation | `web/src/components/AppNav.tsx` | Proofs and Connections; account tools in account menu |
| Web list | `web/src/screens/ProofsScreen.tsx` | All, Needs attention, Completed; one creation control |
| Legacy routes and remembered filters | `web/src/proof-list-state.ts` | Replace redirects preserve usable IDs/query; no added Back loop |
| Web scroll and focus | `web/src/navigation-context.ts` | Account/API-scoped anchors and relative offset |
| Native navigation and screen dispatch | `mobile/src/app/{navigation.ts,Root.tsx,PackProofProvider.tsx}` | One Proofs home and existing record/capture stack |
| Native list | `mobile/src/screens/MyProofsScreen.tsx` | Same state contract and canonical IDs |
| Shared status/action rules | `backend/src/domain/proof-presentation.ts` | Pure shared TypeScript; server facts plus truthful local recovery overlay |
| Complete accessible list query | `backend/src/domain/proof-collection.ts` | Filter/search/sort before pagination; old no-query API remains compatible |
| Automatic order binding | `backend/src/domain/commerce-fulfillment-sync.ts` | Existing idempotent imported transaction and create-or-get Proof path |
| Canonical record | `backend/src/domain/canonical-proof.ts` | Authoritative evidence/finalization, viewer-specific presentation |
| Record viewers | `web/src/components/{WorkspaceProofRecord.tsx,SharedProofRecord.tsx}` and `mobile/src/ui/ProofRecord.tsx` | Recording, history and tracking in the same record hierarchy |
| Share preview and grant reuse | `backend/src/domain/disclosure.ts`, `web/src/components/PrivacySharePanel.tsx`, `mobile/src/screens/SharingScreen.tsx` | Existing seller authority, scoped cache, online expiry/revocation verification |
| Homepage overlap and visual tokens | `web/src/site/{experience.css,brand-palette.css,paper-system.css}` | Normal document flow, wrapping and explicit gap |
| Production brand assets | `web/public/brand/`, `mobile/assets/` | Flat vector paths, exact traced approved lettering, mono and small-size assets |

## State and access guarantees

- Evidence completion comes from server finalization, independently of shipment delivery.
- Waiting and normal upload progress do not create an unnecessary action. Interrupted local work can be actionable without claiming that its bytes are committed.
- Invitations appear once per canonical Proof. Receiver-only access continues through the existing lifecycle route; it does not gain seller media or canonical participant privileges.
- Valid cached shared-Proof links are reused. Hash-only server token storage remains intact; a fresh device cannot reconstruct an uncached token.
- An unfinished shared record explicitly states that recording is absent or upload is pending. Only committed, authorized media can be fetched.
- Share never finalizes, edits shipment identity, or attests for another person. Seller biometric confirmation retains the exact statement and stores no raw biometric data.
- Technical integrity details remain available within the Proof. Deprecated primary queues are replaced by compatibility routes, not by deletion of their underlying operations.

## Visual system

Workspace `#F5F2E9`; document `#FFFEFA`; primary ink `#26302D`; secondary `#59635F`; selected/link slate `#56727B`; confirmation forest `#365F4C`; rules `#D9D8CF`. Noto Serif and Noto Sans are bundled with their SIL Open Font License. Approved logo lettering is traced into paths; no webfont substitution or raster embedded inside SVG is used.

Contrast measured on workspace paper: primary 12.16:1, secondary 5.56:1, slate 4.59:1 and forest 6.47:1. Stronger interactive boundaries exceed 3:1. The narrow homepage heading-to-content gap measured 24 px without horizontal overflow.

## Validation and release evidence

Execution results, source identifiers, published version, backend task/image and Android artifact hash are recorded in `release-evidence.json` at handoff. Screenshots use controlled local fixtures, never seeded customer workspace data.

Required acceptance includes empty/mixed/error/loading lists, unrecorded and completed records, pending/failed upload, confirmation, Connections, public incomplete/completed records, legacy/deep links, query/filter/scroll/focus restoration and the homepage overlap. Automated tests protect API permissions, canonical identity, late-page search, committed-media isolation, scope reuse and capture/attestation recovery.

## Physical device limits

The Galaxy S24 Ultra and A16 5G are not attached to this execution environment. Installation, upgrade, real fingerprint dialogs, hardware camera capture, airplane-mode/force-stop recovery, TalkBack and system font scaling on those devices cannot be marked passed here. Native orientation remains portrait to preserve verified camera/encoder behavior; landscape capture is not claimed as verified. Signed build production and installation are reported separately.

Rollback uses the previous compatible image/web version or Android build. It does not reverse migrations, remove new evidence, reset databases or invalidate canonical Proof IDs.
