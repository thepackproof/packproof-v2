# PackProof — Evidence in Motion implementation candidate

This change replaces the React public homepage with a nine-scene cinematic presentation and adds a shared public navigation/motion system plus eleven supporting public routes. It is a source implementation candidate, not a completed production release.

## What is implemented

- Oversized kinetic hero, dimensional evidence panels and a source-linked constellation.
- Scroll-linked order/evidence/shipping assembly without changing native scrolling.
- Keyboard-operable source tabs, sample chronology, footage bookmarks, fingerprint illustration and participant views.
- Existing licensed packing footage, with its stock provenance and missing seal/label/handoff disclosed.
- Distinct supporting pages for workflow, integrity, sellers, buyers, reviewers, platform/API, integrations, about, security, independent verification and downloads.
- Shared compact navigation, mobile menu, hover/press feedback, page entry motion and a persistent motion control.
- OS reduced-motion preference, static scene compositions, restored focus, observer cleanup and offscreen ambient-animation pausing.
- Existing sample, contact form, legal components and lazy application/authentication entry retained. Contact uses admin@thepackproof.com.
- Public metadata and Inter font preload updated. Anonymous CTA events accept canonical trailing-slash public routes and continue to honor DNT/GPC.

No package dependency, backend, evidence lifecycle, authentication protocol, mobile capture workflow or database change is required.

## Source boundaries and production blocker

GitHub base: thepackproof/packproof-v2 at 36c6951a948c4ede3a103760f82dbd71ae693d94.

The selected live Site is appgprj_6a9c2365007c8191a0958c54e4a67b95 at https://thepackproof.com. Its saved version 61 references 9924fae9764e7a0a337bfb3b9467a8af27aa6203.

The live Site has generated marketing routes and an Evidence Library that are absent from the GitHub React source. Its source connection could not be opened because the execution workspace cannot reach the Git host. A full React bundle must not replace that hosted deployment until those files and routes have been reconciled. The Evidence Library link points to its current canonical live location; no articles or investor content have been recreated or removed.

Publication is not waiting for another user approval. It is waiting for access to the authoritative hosted source and preservation of the existing route set.

Checks were run in an isolated copy of the locally available web source and dependencies. The changed public entry and analytics files were reconciled with the GitHub base. A complete checkout of the newer GitHub tree was unavailable, so CI must also validate this draft against the current repository.

## Validation completed

- Full web TypeScript check passed.
- Vite production build passed.
- Six new behavioral checks passed: local motion preference/persistence; OS preference; menu Escape/focus behavior; keyboard source selection; canonical public CTA events; GPC analytics suppression.
- Three existing website routing checks passed: actual sign-in entry, account-free sample opening/closing, and canonical sample tabs.
- Standalone review bundle compiled and executed in a DOM test: nine scenes, source selection, motion toggle and no runtime errors.

No unrelated backend test suite was run. Existing Vite warnings about the application chunk size and mixed static/dynamic identifier imports remain; they are outside this presentation change.

## Verification still required

The local server started, but sandbox socket restrictions prevented both in-app and local-browser access. Desktop/mobile screenshots, real-device interaction, visual match, media/network fallbacks and measured Core Web Vitals are unverified. Do not treat the DOM checks as a substitute for these browser checks.

After restoring source access, transplant this public presentation into the hosted source while retaining its API bridge, app assets, Evidence Library, investor page, legal routes, app associations and existing URLs. Verify the primary account/sample actions and representative 360/390/430/768/1024/1440 layouts. Check reduced motion and keyboard navigation in a real browser, then measure performance on a defined mobile profile.

## Review preview

Run from the repository root after web dependencies are available:

    node web/scripts/build-motion-review.mjs

Open web/review-output/PackProof-Evidence-in-Motion.html. The preview embeds its JavaScript, CSS, brand assets, poster and font. Packing video loads from the current public domain. Navigation between implemented design pages remains inside the preview; account, sample, contact and legal links open the current public site. It has no backend or analytics connection and is marked noindex.

The preview is for reviewing the implemented public presentation. It does not replace the real sample or an authenticated application.

## Rollback

Revert the source change to restore the previous React public presentation. There are no data migrations or backend changes. If later published through Sites, retain the current saved version as the deployment rollback target.


