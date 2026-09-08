# Mobile build dependency security — 7 September 2026

The Expo 52 / React Native 0.76 runtime versions remain unchanged. The dependency
changes concern Node build tooling, not server parsing of uploaded evidence.

## Changes and compatibility

- `tar` is pinned to **7.5.22**. The maintainer's final applicable advisory lists
  **7.5.21** as patched for the recursive member-filter denial of service; this
  pin also clears the earlier tar advisory family found by `npm audit`.
  [Maintainer advisory](https://github.com/isaacs/node-tar/security/advisories/GHSA-r292-9mhp-454m).
- Expo CLI 0.22.28 has two transpiled default imports of tar. Tar 7 CommonJS sets
  `__esModule` and exposes named exports without a default. A checked installation
  patch preserves Expo's existing extraction calls using the named namespace.
  Tests exercise Expo's actual streaming npm-tarball extraction and reject a
  traversal archive without writing outside the destination.
- `image-size` is replaced with the exact npm alias
  **`npm:image-size-next@1.2.2`**, the community-maintained legacy fork that retains
  the callable synchronous API used by Metro. The original package has no patched
  release for the two current advisories. The fork repairs ICNS entry-length and
  ISO-BMFF box-walker progress, JXL partial-stream progress, and malformed JPEG
  segment lengths. Its published runtime was compared against the installed
  1.2.1 runtime: only the six parser/helper JavaScript files and one helper type
  declaration differ. The public entrypoint is unchanged before our existing guard.
  [ICNS advisory](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr),
  [JXL/HEIF advisory](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq),
  [Reviewed fork delta](https://github.com/lcf2212dev/image-size-next/compare/v1.2.1...v1.2.2).
- A checked installation guard rejects ICNS, JXL container, and ISO-BMFF image
  signatures **before detection**. This deliberately excludes AVIF/HEIF from
  build assets; use PNG or JPEG. Merely calling `disableTypes()` is insufficient:
  image type validation already calls the affected box walker. File extensions
  do not bypass the guard. This remains defense in depth in addition to the
  actual parser repairs; the guard is not used to suppress audit findings.

The replacement is pinned by name, version, and npm tarball SHA-512 in the lockfile.
Its integrity is
`sha512-Pd3CJ2+Ifk2H2jWikkoz2BSZgnuF3Qsea4gQmj2gtiOtYpGWBl7elj8EXnFMiY5PaYNruTTLD0hQ0UWK7pz9xA==`.
It has no install lifecycle script and retains the existing `queue@6.0.2`
dependency. The image-size command-line binary is renamed by the fork; PackProof
uses Metro's module API, not that binary.

`npm ci` runs `scripts/secure-build-dependencies.cjs` through `postinstall`. Every
patched file must match its exact source SHA-256 or exact expected patched
source; an unexpected image parser package identity also stops installation for
review. Repeated installation is
idempotent. Do not build with lifecycle scripts disabled. Any future toolchain
upgrade must review and replace these narrow patches.

## Evidence and remaining gates

- Mobile TypeScript check passed.
- Clean `npm ci` followed by the security tests passed with the locked replacement.
- Offline Android JavaScript/Hermes export passed: 782 bundled modules and 20
  assets, using `expo export --platform android --max-workers 2`. This validates
  Metro and the app bundle; it is not a native AAB build.
- Six build dependency tests pass: patch integrity/idempotency; pinned installed
  and locked package identity; direct underlying parser progress checks bypassing
  the guard; malformed
  zero-length ICNS/JXL/HEIF containers including `.png` filenames and buffer/file
  APIs; Metro PNG sizing; Expo tar extraction and traversal rejection.
- Registry audit after the image parser replacement reports **0 findings at all
  severities**, down from **6 high** in the previous candidate. The standard
  `npm audit --audit-level=high` gate remains enabled with no advisory waiver.
- Test commands: `npm run typecheck` and `npm run test:build-security` in `mobile`.
- Kotlin compilation remains unverified locally because required Maven artifacts
  were unavailable offline and the Maven network retry failed. These Node tests
  do not establish native compilation, AAB readiness, real biometric behavior,
  TalkBack usability, force-stop recovery on physical devices, or deployment.
  Native compilation and physical-device tests remain release gates.
