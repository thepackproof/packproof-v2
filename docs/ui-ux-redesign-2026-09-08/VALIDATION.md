# Candidate validation record

The candidate PR and its CI records identify the exact published source SHA. Commands below ran in the implementation checkout on September 8, 2026. They exercise real client/domain code using controlled fixtures. They do not establish installed-device, live-provider or human usability acceptance.

| Check | Command / evidence | Result |
|---|---|---|
| Mobile TypeScript | `cd mobile && npm run typecheck` | PASS |
| Mobile full TypeScript tests | `node --import ../backend/node_modules/tsx/dist/loader.mjs --test tests/*.test.ts` | 87 passed; 0 failed; 0 skipped |
| Mobile dependency/release security | `cd mobile && npm run test:build-security` | 8 passed; 0 failed |
| Persistent redesign gate | `cd mobile && npm run test:redesign` | 19 passed; included in CI |
| Web TypeScript | `cd web && npm run typecheck` | PASS |
| Web full suite | `cd web && npm test -- --maxWorkers=2` | 29 files; 190 passed; 0 failed |
| Web production bundle | `cd web && npm run build` | PASS; 189 transformed modules |
| Backend TypeScript / build | `cd backend && npm run typecheck` / `npm run build` | PASS |
| Initial backend full suite | `cd backend && npm test -- --maxWorkers=2` | 712 passed, 10 failed, 11 skipped; failures investigated and corrected |
| Backend regression verification | Eight affected/new files with `vitest run --maxWorkers=2` | 105 passed, 0 failed |
| W5 schema/consent | `backend/tests/study-ui-instrumentation.test.ts` plus shared bridge/native/web timing suites | PASS in the complete local suites |
| Final local complete backend | `cd backend && npm test -- --maxWorkers=3` | 750 passed, 1 failed, 11 skipped; sole remaining legacy manual-creation Back expectation corrected and origin cases added. See exact-source CI for the final complete result. |
| Android Back regression | `cd backend && npx vitest run tests/android-back-compat.test.ts --maxWorkers=2` | 17 passed; 0 failed, including both Orders and Station origins |
| Android native compilation | Existing CI Android attestation Kotlin job | Candidate CI found a nullable optional bounds value incompatible with EventDispatcher; fixed by omitting unavailable bounds. See final PR for exact-source native compilation status. |
| Signed release AAB | Existing `shipping-integration` EAS profile / signing lineage | NOT PRODUCED; authorized Expo automation token unavailable in inspected prior run |
| Physical S24 Ultra / A16 5G | Exact installed-candidate protocol in RELEASE.md | NOT TESTED |
| Eight-person usability | Counterbalanced tasks and thresholds in RELEASE.md | NOT RUN |
| Production rollout | API/web/mobile candidate alignment and all required gates | NOT DEPLOYED |

The backend regression rerun includes redesign-integrity, mobile-ui-presentation, mobile-theme, mobile-capture-capabilities, adversarial-evidence-boundaries, commerce-automation, signature-experiences and packing-station. Imported mutation fixtures now assert rejection; explicitly marked historical correction fixtures preserve legacy attribution tests. Label swaps still preserve both observations and block finalization pending an attributed review. No test was skipped to hide a redesign failure.

## Browser evidence

The supervised browser preview loaded the public deletion resource and its privacy link. The fictional sample exposed Recording / Activity / Tracking; keyboard Right Arrow moved from Activity to Tracking, and the illustrative carrier disclaimer remained visible. A temporary isolated harness rendered the real Orders and Account components with synthetic inputs at 360 CSS-pixel content width in light/dark. Titles wrap, Account stays compact, action and success colors differ. Header spacer and primary-title color issues were fixed and inspected. Harness files were removed before publication. No customer session or live recording was fabricated. This is supporting visual evidence, not a substitute for 200% text/TalkBack or a complete authenticated-device task.

## Release limitations

Configured candidate: 0.3.9 / versionCode 38, package com.packproof.mobile. Check EAS/Play history before the signed build; the inspected old artifact was 0.3.8 / 37. The current live API is older than this source, so the new app intentionally blocks new ordinary recordings until required server capabilities are present. The old AAB is not a redesign deliverable. Local originals and legacy journals remain protected.
