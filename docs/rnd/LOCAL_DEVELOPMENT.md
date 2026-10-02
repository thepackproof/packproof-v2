# Run the isolated research build

This branch contains research implementation and synthetic measurements. It is not authorized for production, app-store distribution, customer findings, or real-party pilots. Its committed build marker prevents distribution even if the branch is renamed.

## First run

Install the committed npm locks for `backend`, `mobile`, `web` and `desktop`, then build the API:

```sh
npm ci --prefix backend
npm ci --prefix mobile
npm ci --prefix web
npm ci --prefix desktop
npm run build --prefix backend
npm run rnd -- init --dir /tmp/packproof-rnd-local
npm run rnd -- serve --dir /tmp/packproof-rnd-local
```

`init` requires a new private directory outside the repository. It creates a P-256 research signing key, a 30-day public test trust snapshot and a random local upload secret. Do not commit that directory. The key is research material; generating it does not establish independent trust. `serve` starts a loopback-only API backed by a separate local PGlite database and object directory. The child environment excludes inherited cloud/service credentials. Optional processing is disabled by default.

The startup command was exercised with a fresh database: all additive migrations completed, `/health` returned HTTP200, unauthenticated research access returned HTTP401, and an authenticated local test identity saw `enabled:false`, `killSwitch:true`, and all feature operations false. The temporary process was stopped afterward.

To inspect the web research surface:

```sh
VITE_PACKPROOF_RND=1 VITE_PACKPROOF_API_BASE_URL=http://127.0.0.1:3000 npm run dev --prefix web
```

Research web/mobile/desktop configuration rejects remote API origins and uses distinct local identities/build identifiers/session storage. Sign in only with a local development identity. No live account credentials are needed.

## Explicitly enable an experiment

Install the pinned isolated vision environment described in `research/vision/README.md`. Configure the private decoder launcher from `research/ISOLATION.md` on a supported Linux host. The local synthetic harness can be run separately when that host's namespace permissions are unavailable; it must not be described as an isolated decoder deployment.

```sh
PACKPROOF_RND_PYTHON=/private/vision-venv/bin/python \
PACKPROOF_RND_WORKER_SCRIPT="$PWD/research/vision/worker.py" \
npm run rnd -- serve --dir /tmp/packproof-rnd-local --features proofpilot,proofsight,proofprint,prooftwin
```

This explicitly enables collection, processing and internal display only for those named features. Customer display stays disabled. Each Proof also needs purpose-bound research consent and immutable committed sources. Revoking consent blocks subsequent work. Stop the local process and restart without `--features` to close all optional controls. Active recording is independent of server analysis availability.

Privacy, platform assurance, witness identity, and federated report trust require their documented dedicated configurations. The convenience runner does not copy their credentials. See `PLATFORM_ASSURANCE.md`, `research/privacy/README.md`, `research/witness/README.md`, and `research/federated/README.md`.

## Review and verification

The authenticated web and desktop reviewer includes observations, intervals and gaps, source navigation, per-channel comparisons, exact-byte redaction review, attributed participant corrections, derived maps and rotatable sparse points with 2D projections. Sparse geometry has unknown metric scale and no filled hidden surfaces. A pinned source can be inspected alongside another source. Mobile uses its native research review and capture controls.

Export the metadata record or the authorized archive containing originals. Derivative exports require human review of the exact artifact and recipe and omit originals and source-dependent private fields. Scoped grants expire after15minutes,1hour or24hours; the code appears once, is never placed in a URL, and can be revoked. The local research recipient enters it at `/research/derivative`. No recipient is contacted by this implementation run. A participant correction remains a signed statement separate from machine results and preserves the earlier statement it supersedes.

```sh
npm run rnd -- verify /private/extracted-research-archive --trust /private/pinned-public-trust.json
```

Obtain the verification policy through a trusted channel; keys embedded in an export do not establish their own authority. The verifier checks frozen legacy root bytes, signed research records, subject and source links, ordered extension/receipt inventories and the signed export snapshot. Providing extracted files additionally checks their bytes. Its success does not certify physical truth, hardware provenance, independent witnessing or a ZK relation; those use separate explicitly labeled checks.

The isolated web admin workspace has a Research operations page for durable queue state, lease/age alerts, error counts, controlled-witness checkpoint health and audited retries. These alerts stay in the local dashboard; hosted cost and device overhead remain unmeasured.

## Reproduce checks and measurements

```sh
npm run rnd -- doctor
npm run rnd -- test core
PACKPROOF_RND_PYTHON=/private/vision-venv/bin/python npm run rnd -- test research
npm run rnd -- report --output /private/rnd-handoff.json
```

`bench F01|F03|F04|F06|F08 --output DIR` runs the vision synthetic harness; `F04 --sparse3d` includes actual COLMAP reconstruction. `F07`, `F09` and `F10` use their separate pinned environments and real cryptographic/protocol implementations. These benchmark commands create local artifacts; they do not upload evidence or promote a model. Exact feature commands, scope, populations and unmet gates are recorded in `status-ledger.json` and the linked feature reports.
