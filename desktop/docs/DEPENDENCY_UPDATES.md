# Desktop 1.0.1 dependency update

The desktop renderer remains bundled locally. This update pins compatible build
dependencies, removes the old logging/formatting dependency chain from the
Electron downloader, and audits every dependency in both candidate and signed
release workflows. No audit exclusions or signature-policy changes are used.

| Dependency | Selection | Reason and compatibility boundary |
| --- | --- | --- |
| Vitest | 4.1.11 | Replaces Vitest 3 and its vulnerable tinypool dependency. All desktop tests run on the new major. |
| source-map-js | 1.2.2 | Pins the published fix for GHSA-68fv-2mgg-jv7q through all paths. |
| http-cache-semantics | 4.3.0 | Updates the build download dependency to the current upstream release outside the registry advisory range. |
| global-agent | 4.1.3, only under @electron/get 3.1.0 | Maintains the CommonJS bootstrap API used by electron-builder; removes roarr 2 and sprintf-js, for which no patched upstream version is published. |

`tests/build-dependency-compatibility.test.ts` exercises the actual nested
`@electron/get` proxy adapter in an isolated Node process. Requests traverse a
local HTTP proxy and bypass it for `NO_PROXY`; the test performs no external
downloads and does not modify the test runner's global HTTP agent. Cache tests
cover storage exclusions for private, authenticated and no-store responses,
mandatory revalidation, request no-cache, and normal public artifact reuse.

The http-cache-semantics advisory is disputed by its maintainer. Version 4.3.0
clears the current registry advisory range but is not claimed here as proof of
safe arbitrary shared-cache behavior: its response no-cache/proxy-revalidate
handling with request max-stale retains the upstream behavior. The Electron
build adapter uses `got.stream` without enabling got's optional HTTP response
cache. Installer download checksum verification remains enabled. This package
is a build dependency, not the PackProof renderer or evidence transport cache.

The lockfile was resolved with npm 11.12.0 after npm 10.9.8 encountered an
Arborist optional-peer resolution error; ordinary npm 10.9.8 `npm ci` then
installed the resulting lockfile successfully. Neither `--force` nor
`--legacy-peer-deps` is required.

Upstream references:

- [global-agent 4.0 release and API compatibility](https://github.com/gajus/global-agent/releases/tag/v4.0.0)
- [sprintf-js advisory and absence of an upstream patched release](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
- [http-cache-semantics advisory dispute](https://github.com/github/advisory-database/issues/10139)

Zero registry findings, unit tests, and builds are separate from installed-app
acceptance. The 18 production acceptance gates and signed publication policy in
`RELEASING.md` remain required.
