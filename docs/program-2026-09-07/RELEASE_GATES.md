# Exact-source release evidence

Run `node scripts/release-bom.mjs --out /tmp/packproof-release-bom.json` from the repository root after committing the intended release. The collector rejects dirty source by default and can require `--expected-sha <commit>`. `--allow-dirty` produces an explicitly labeled engineering candidate; it does not establish release parity.

Add `--api-dist backend/dist`, `--web-dist web/dist`, and `--android-artifact /path/to/build.aab` when those exact artifacts exist. Files are hashed through streams; asset inventories include each path/digest and a deterministic tree digest. No repository or environment secret values are inspected or copied.

Populate `runtime-evidence.template.v1.json` from dated inspected runtime/distribution/device evidence and pass it with `--runtime-evidence <file>`. Use migration IDs without `.sql` and SHA-256 of their exact source bytes. Record both test-phone installation evidence and artifact identity. Runtime facts remain labeled reported evidence requiring review; the collector cannot remotely prove an installation or deployment. It lists missing identities and rejects mismatches. It never auto-passes G1.

The BOM includes every migration checksum, lockfile hashes, source commit/tree, source-configured Android version/build, available artifact hashes, supplied API image digest and environment/capability/flag/signing/trust references. Dependency inventory comes from each lockfile's package name/version/license metadata, with missing license information explicit. This is an inventory for review, not legal approval of dependencies.

The CI workflow adds these release checks at its exact checkout SHA:

| Check | Required evidence |
|---|---|
| Backend | Typecheck, tests, compiled API tree and source/migration BOM. |
| Web | Tests plus two builds with identical asset bytes, followed by a web BOM. |
| Mobile | TypeScript/shared Proof contracts. |
| Android attestation Kotlin | Both `packproof-attestation` and `packproof-unified-camera` release Kotlin compilation. This is not an installed-device test. |
| PostgreSQL release invariants | Independent actual PostgreSQL pools race Proof creation, account quota admission, commits, strict finalization, signed supplement allocation and hold/disposition. Existing concurrent startup migrations also run. |
| Dependency audit | Backend, web and mobile fail on known high or critical npm findings. Source lockfile identity accompanies the release BOM. |
| Source secrets and release tooling | BOM behavior tests plus a redacted repository-history scan with the pinned open-source Gitleaks CLI. No paid action license or disabled-scan fallback. |
| CodeQL / deployment scripts | Existing separate CodeQL workflow and PowerShell runtime-preservation tests remain applicable. |

The real PostgreSQL job sets both `PACKPROOF_RELEASE_TEST_DATABASE_URL` and `PACKPROOF_REQUIRE_POSTGRES_RELEASE_GATES=1`; missing database configuration then fails, rather than turning a mandatory gate into skipped tests. Local runs without PostgreSQL may collect four skipped cases, which do not satisfy W01-C. Tests create and remove only a randomly named isolated schema and use synthetic signing/object fixtures. They prove database concurrency behavior, not live S3 protection, cloud restore or legal approval.

The scanner installation and command follow the [official Gitleaks documentation](https://github.com/gitleaks/gitleaks) and use [v8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1), checked for this implementation. Findings are redacted; no blanket baseline suppresses historical discoveries. A finding requires actual remediation or a narrowly documented false-positive/rotation disposition. A successful scanner is not an independent penetration test.

Protect main using the actual check names above, disallow unchecked force pushes, and retain separate review of integrity/authentication/migration/deployment changes. Repository-host settings must be inspected and exercised; merely writing a workflow cannot prove branch protections. An Android rollback uses a compatible higher version or feature gating. A complete release still needs the deployed runtime/schema, exact signed AAB distribution, both physical installations, controlled rollout and rollback evidence.
