# PackProof picomatch builds

PackProof maintains these scoped builds for GHSA-fc5q-39xc-vjpf while the npm advisory lists no fixed upstream version. Existing consumers keep their module import and their upstream major version. The tarballs contain the original MIT license and upstream files, plus the patch to the parser and an explicit fork identity in the package metadata.

| Upstream package | PackProof package version | Used by |
| --- | --- | --- |
| picomatch 4.0.7 | @packproof/picomatch 4.0.7-packproof.1 | Vite, Vitest and desktop build tooling |
| picomatch 3.0.2 | @packproof/picomatch 3.0.2-packproof.1 | Expo CLI |
| picomatch 2.3.2 | @packproof/picomatch 2.3.2-packproof.1 | anymatch, Jest and micromatch in the mobile toolchain |

The compiler tracks unbounded tokens through nested groups. A repeated simple filename segment with one wildcard needs only one pass and keeps its matching behavior. More complex repeated extglobs with an unbounded body use the parser’s existing literal fallback when it cannot emit a safe form. Ordinary globstars, brace expansion, negation, escaping and bracket classes use each version’s original parser. The extra guard also applies when a caller explicitly disables the older recursion threshold.

This is PackProof’s own backport. The compiler-frame approach is informed by [upstream proposal 274](https://github.com/micromatch/picomatch/pull/274/commits/3975e4a0e6b4c4fb2c0119863b243ce04612c5e3), and the single-wildcard rewrite by [proposal 270](https://github.com/micromatch/picomatch/pull/270/commits/614ef37229ceea362ccbc729fb64e98a7e327dc8). Neither proposal was an upstream release when adopted. [GitHub advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)

From the repository root, run `python3 backend/vendor/picomatch/rebuild.py --check` to verify each fork against the SHA-512-pinned npm release and the reviewed patch. An offline run can pass `--cache DIRECTORY` with the three original npm archives. The 2.x and 3.x tarballs live inside the mobile project for its standalone builds. The 4.x tarball is included in the backend build context. Each application lockfile pins its tarball integrity.

After `npm ci`, run `node ../backend/vendor/picomatch/verify.cjs` from an application directory. It checks the implementation resolved by each consumer, common filename behavior and the generated structure of a repeated filename rule. The ordinary full npm audit remains enabled. CI separately audits all three original version identities for new high and critical advisories. Retire each fork when a compatible fixed upstream release is available and has passed the same consumer checks.
