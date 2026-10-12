# Local research runtime

No R&D surface is configured to distribute. Use a separate local database, local object directory, local development identities and newly generated research signing keys. All four feature controls and the global kill switch default closed. `config/rnd/local.env.example` is a template, not an enabled environment.

The backend TypeScript build imports the versioned contracts from the repository root. `research/backend.Dockerfile` uses that root build context; it is separate from the protected production image recipe. The container smoke gate must be run on a Docker-capable host; source inspection alone does not establish a working image. This image does not contain decoder environments and cannot run image jobs until an explicitly configured worker is available. Do not add cloud credentials to it.

## Decoder containment

`scripts/rnd-worker-sandbox.mjs` is a fail-closed Bubblewrap launcher for Linux hosts with unprivileged namespaces and proc mounts permitted. Set the absolute executable path as `PACKPROOF_RND_SANDBOX_EXECUTABLE` and a JSON argument array as `PACKPROOF_RND_SANDBOX_ARGS`, for example:

```text
["--runtime","/opt/packproof-vision","--code","/app/research","--"]
```

The Python executable must belong to that venv. The research code directory and interpreter are read-only; only the backend-owned mode-0700 job directory is writable. The launcher mounts neither the host root nor homes nor cloud configuration, clears the environment, creates separate PID/network/user namespaces, drops capabilities, and enforces process limits. It only permits the vision and redaction entry points. Source files are privately materialized and verified by digest before decoding. The parent kills the process group on timeout and deletes the job directory after completion or failure. Proving and witness processes have distinct trust/credential requirements and must use their own isolated service profiles.

This environment rejected Bubblewrap's proc mount (`Operation not permitted`), including the permitted elevated check. Therefore **namespace containment is implemented but not validated on this host**. Do not remove the wrapper to claim a contained run: a failure must remain an operational failure. The explicitly documented local synthetic harness uses bounded subprocesses without network namespaces; its measurements are not decoder-isolation qualification.

Before consented pilots, execute the actual worker under this wrapper on the target Linux host, verify that external network access and unrelated files are unavailable, run malicious decoder/resource fixtures, and record the host kernel, Bubblewrap version and results. No pilot or production decoder isolation is certified by this branch.

## Reproducible Linux containment check

`scripts/rnd-sandbox-probe.mjs` exercises the real launcher with no cloud credentials,
customer evidence, outside network destination or release authority. It requires an
unprivileged Linux host that permits the namespaces Bubblewrap needs. Unsupported or
denied containment fails the command; it is never silently replaced with a bare worker.
Ubuntu 22.04 CI is the intended first execution host. Do not disable a host's global
AppArmor, namespace or other security policies to make the check pass.

After installing Bubblewrap, util-linux, FFmpeg, and the separately pinned vision and
privacy Python 3.12 environments:

```sh
node --test scripts/rnd-worker-sandbox.test.mjs
python -m unittest research.benchmarks.test_worker_limits -v
node scripts/rnd-sandbox-probe.mjs \
  --vision-runtime /tmp/packproof-vision-venv \
  --privacy-runtime /tmp/packproof-privacy-venv \
  --report /tmp/rnd-sandbox-report.json
```

The hostile fixture is copied into a temporary allowed entry point, without adding a
new production entry point. It checks separate mount/user/PID/network namespaces,
blocked access to a host loopback listener and an unrelated synthetic canary, absent
external network routes, removed host environment, dropped capabilities, read-only
runtime/code mounts, and writable job/private temporary space. Child processes
actually attempt address-space allocation, file growth and descriptor exhaustion;
the CPU limit is inspected, without consuming its full 55-second budget. These are
per-process/per-file limits, not an aggregate process-tree memory or disk quota.

The same run executes the real vision worker on a committed synthetic image, rejects
a malformed synthetic image without issuing a finding, and creates a real unsigned,
review-required redaction while checking source and derivative hashes. The sanitized
JSON records host/kernel/tool/source identity, each check, and a static failure stage.
It contains neither environment values nor private key material. A pass qualifies only
this measured synthetic decoder boundary on that host; it does not establish physical
accuracy, pilot readiness, or containment of the separate ZK and witness processes.

The launcher now mounts an exact `/opt` base-Python installation when a venv points
there (as with GitHub setup-python), validates exact job inputs and output boundaries,
and rejects signing-key arguments. Vision process limits clamp to inherited ceilings
rather than attempting to raise Bubblewrap's stricter CPU/file-size limits. Runtime
qualification remains pending until a source-bound Linux result actually passes.

## Isolated container startup gate

```sh
docker build -f research/backend.Dockerfile -t packproof-rnd-smoke .
node research/container-smoke.mjs packproof-rnd-smoke --report /tmp/rnd-container-report.json
```

The dedicated image includes the PGlite runtime dependency and starts as UID 1000 with a private writable `/research/session` directory. Its entrypoint creates a new local research key and database on first start, reuses them on restart, and strips inherited cloud/service settings. All optional feature flags remain off. The smoke gate uses Docker's `none` network, exercises health and authenticated research capability access from inside the container, and checks database identity survives restart. It does not exercise decoders, native capture, external trust or deployment. The API stays bound to container loopback: ordinary port publishing is intentionally ineffective. For an interactive local Linux host, explicitly use host networking; do not change the API to a public listener. Container filesystem storage is retained only while that container exists; mount a private UID-1000-owned volume at `/research` for a deliberate persistent local setup. Never mount production data or credentials.
