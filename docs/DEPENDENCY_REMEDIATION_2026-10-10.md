# Dependency remediation — October 10, 2026

This change resolves the dependency findings recorded for the mobile UX candidate
without changing evidence contracts, disabling audit checks, or changing the Expo
53 / React Native 0.79 platform. Build and test evidence must remain attached to
the exact source revision and artifact receipts; dependency remediation does not
establish physical-device or production acceptance.

## Backend and web

| Dependency | Resolution | Reason |
| --- | --- | --- |
| `proxy-addr` | 2.0.7 → 2.0.8 in the backend lockfile | Upstream fix for [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h). Express's existing compatible range accepts the patch. |
| `source-map-js` | 1.2.1 → 1.2.2 in backend and web | Upstream fix for [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q). |
| `vitest` / `@vitest/*` | 3.2.7 → 4.1.11 | Upstream fix for [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9); the advisory does not offer a maintained 3.x patch. |
| `tinypool` | Removed by Vitest 4 | Removes the dependency affected by [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3) and [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr). |

Backend explicitly declares development dependency Vite 7 so Vitest's broad
supported range does not silently select Vite 8. Both locks retain Vite 7.3.6.
The [Vitest migration guide](https://v4.vitest.dev/guide/migration) describes the
new worker architecture and supported Node/Vite versions. No application behavior
or test expectations are changed to accommodate the new runner.

`backend/tests/trusted-proxy-dependency.test.ts` exercises the configured Express
trust function: short mapped/generic IPv6 subnets must not trust arbitrary public
IPv4 addresses; correctly expressed mapped, IPv4, and IPv6 subnets retain their
intended boundaries.

## Mobile: upstream fixes unavailable

The following upstream advisories reported no patched release when checked on
October 10. Registry package renaming alone would not fix these defects. The
repository contains identifiable private local forks with actual source patches,
preserved upstream licensing, original tarball integrity, reviewed file hashes,
and regression coverage:

- [Braces patch and maintenance notes](../mobile/vendor/braces/PATCHES.md):
  [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
  Structural nesting is bounded to 128 before parsing or recursive AST traversal.
  Public and deep-import walkers share the guard; normal glob/range behavior is
  retained. This does not impose a general limit on every combinatorial expansion.
- [node-forge patch and maintenance notes](../mobile/vendor/node-forge/PATCHES.md):
  [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
  RSA DigestInfo validation requires the exact nested child count and empty NULL
  parameters, retaining supported omitted-NULL SHA signatures. Stale prebuilt
  bundles are excluded, so the installed implementation is the patched source.
  Cryptographic algorithms and key generation are unchanged.

The remaining [sprintf-js advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
is addressed by removing that dependency path. The two legacy js-yaml consumers
are scoped to official js-yaml 4.3.2. A hash-checked adapter changes cosmiconfig's
obsolete `safeLoad` call to `load`, whose default schema excludes executable YAML
types. The other consumer already uses `load`. Configuration loading and rejection
of executable YAML tags are tested through the actual consumers.

Local forks are not assessed by the registry advisory service. Therefore a clean
`npm audit` is only one part of this remediation evidence. The postinstall guard
verifies every shipped fork file and installed consumer resolution; security tests
verify malformed inputs, positive compatibility, and rejection of modified or
unexpected files. Exact vendor bytes are preserved across Git checkouts. Review
these forks when upstream patches become available, replace them with supported
upstream releases when compatible, and retain the defect regressions.

The source secret scanner retains all default rules and full history. Two
reviewed upstream false positives have exceptions requiring the exact file path,
full source line, and `generic-api-key` rule: the public Forge README seed example
and the PKCS12 function alias assignment. Vendor directories are not excluded.
Negative controls confirm the example is still detected at a different path or
when its source line changes.

## Required verification

- Clean `npm ci` and full `npm audit --json` for backend, web, and mobile. CI's
  existing high/critical audit threshold remains unchanged; no advisory is ignored.
- Backend typecheck, full tests, compilation, and PostgreSQL invariants on Linux.
- Full web tests, route checks, TypeScript compilation, and deterministic builds.
- Native typecheck, full model/contract tests, build-security regressions, Expo
  compatibility checks, Android compilation, and iOS app/Share Extension compilation.
- The iOS workflow runs `order-share-plugin.test.cjs` again after native generation.
  A required project-file check prevents its generated-project case from silently
  skipping in that phase. The pre-generation local skip remains a separate result.
- Rebuild internal APK, iOS simulator archive, and web review bundle from a clean
  frozen revision; verify source markers, identities, hashes, and static package checks.

Physical recovery/accessibility testing, signed iPhone distribution, live backend
workflows, deployment, and store submission remain separate evidence gates. None
is inferred from a clean audit, passing tests, or a successfully built package.
