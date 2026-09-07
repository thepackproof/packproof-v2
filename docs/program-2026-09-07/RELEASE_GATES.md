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
| Mobile | TypeScript, shared Proof contracts, pinned build-security/release-identity checks and consented timing/recovery/API tests. |
| Android attestation Kotlin | Both native modules compile; generated project builds an explicitly debug-signed APK, with artifact hash/BOM, package metadata and signing-scope record. Tracked build inputs must remain unchanged after prebuild. No installed-device or production-signing claim. |
| PostgreSQL release invariants | Independent actual PostgreSQL pools race Proof creation, account quota admission, commits, strict finalization, signed supplement allocation and hold/disposition. Existing concurrent startup migrations also run. |
| Dependency audit | Backend, web and mobile fail on known high or critical npm findings. Source lockfile identity accompanies the release BOM. |
| Source secrets and release tooling | BOM/publication-policy refusal tests, standalone Python/OpenSSL trust and signed-snapshot tests, plus a redacted repository-history scan with the pinned open-source Gitleaks CLI. No paid action license or disabled-scan fallback. |
| CodeQL / deployment scripts | Existing separate CodeQL workflow and PowerShell runtime-preservation tests remain applicable. |

The real PostgreSQL job sets both `PACKPROOF_RELEASE_TEST_DATABASE_URL` and `PACKPROOF_REQUIRE_POSTGRES_RELEASE_GATES=1`; missing database configuration then fails, rather than turning a mandatory gate into skipped tests. Local runs without PostgreSQL may collect four skipped cases, which do not satisfy W01-C. Tests create and remove only a randomly named isolated schema and use synthetic signing/object fixtures. They prove database concurrency behavior, not live S3 protection, cloud restore or legal approval.

The scanner installation and command follow the [official Gitleaks documentation](https://github.com/gitleaks/gitleaks) and use [v8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1), checked for this implementation. Findings are redacted; no blanket baseline suppresses historical discoveries. A finding requires actual remediation or a narrowly documented false-positive/rotation disposition. A successful scanner is not an independent penetration test.

Protect main using the actual check names above, disallow unchecked force pushes, and retain separate review of integrity/authentication/migration/deployment changes. Repository-host settings must be inspected and exercised; merely writing a workflow cannot prove branch protections. An Android rollback uses a compatible higher version or feature gating. A complete release still needs the deployed runtime/schema, exact signed AAB distribution, both physical installations, controlled rollout and rollback evidence.

Expo prebuild previously rewrote tracked Android/iOS package scripts. The expected `expo run:android` and `expo run:ios` scripts are now committed inputs; CI prints a source diff summary and refuses tracked changes immediately after prebuild. It never resets changed inputs before hashing the build. BOM failures print only fixed diagnostic codes, including source dirty/mismatch and missing input, without raw process errors or supplied evidence contents.

As of the coordinating owner's September 7 repository inspection, main was unprotected, repository rulesets were empty, and detailed protection access returned 403. The available connector cannot administer protections. This is an actual blocked governance gate; workflow source does not satisfy it. The draft implementation PR must retain this limitation and final exact-source results.

## Software scope gates beyond CI

A successful build/test run cannot substitute for unfinished product implementation. The following scope limits must remain in the release/PR description:

- **W13:** paid checkout/enrollment, expected-next-charge/trial/cancellation-state display and enforcement of approved-offer capture allowances are unfinished. General upload quotas and a usage summary do not supply commercial allowance enforcement. Selecting/configuring the provider and approved offer alone does not finish paid continuation.
- **W12:** actual disposition/tombstone/retry automation remains unfinished. Evaluation, dry-run candidates and the hold-serialized lock are implemented. Destructive automation is deliberately sequenced after approved policy and successful restore validation.
- **W11:** full non-core integration/billing/study metadata and post-snapshot audit recovery, and controlled service cutover, remain unfinished. A successful fenced core/policy import is not a complete service restore or zero-loss assurance.
- **W15:** stage/grading client timing hooks remain unfinished. Existing ordinary Android/station timing and canonical stage-start observations do not establish stage/grading active-time coverage.

Keep split/multi-parcel, partial-fulfillment, replacement and relabel allocations outside the supported single-parcel pilot until implemented and tested. This explicit pilot restriction is allowed by the plan but leaves full W06 acceptance open. W17 expansion remains intentionally deferred behind its six documented triggers; this is separate from the unfinished implementation listed above. No green CI run closes all 65 acceptance criteria or G1–G4.
