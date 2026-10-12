# Local research runtime

No R&D surface is configured to distribute. Use a separate local database, local object directory, local development identities and newly generated research signing keys. All four feature controls and the global kill switch default closed. `config/rnd/local.env.example` is a template, not an enabled environment.

The backend TypeScript build imports the versioned contracts from the repository root. `research/backend.Dockerfile` uses that root build context; it is separate from the protected production image recipe. The container smoke gate must be run on a Docker-capable host; source inspection alone does not establish a working image. This image does not contain decoder environments and cannot run image jobs until an explicitly configured worker is available. Do not add cloud credentials to it.

## Decoder containment

`scripts/rnd-worker-sandbox.mjs` is a fail-closed Bubblewrap launcher for Linux hosts with unprivileged namespaces and proc mounts permitted. Set the absolute executable path as `PACKPROOF_RND_SANDBOX_EXECUTABLE` and a JSON argument array as `PACKPROOF_RND_SANDBOX_ARGS`, for example:

```text
["--runtime","/opt/packproof-vision","--code","/app/research","--"]
```

The Python executable must belong to that venv. The research code directory and interpreter are read-only. Writable storage is the backend-owned mode-0700 job directory and a private temporary filesystem; neither exposes other host jobs. The launcher mounts neither the host root nor homes nor cloud configuration, clears the environment, creates separate PID/network/user namespaces, drops capabilities, and enforces process limits. It only permits the vision and redaction entry points. Source files are privately materialized and verified by digest before decoding. The backend parent implements process-group termination on timeout and job-directory cleanup after completion or failure. Proving and witness processes have distinct trust/credential requirements and must use their own isolated service profiles.

The inherited handoff at `41c9af8` reported a prior host rejecting Bubblewrap's proc mount (`Operation not permitted`); that remains a historical failed host observation. The current Windows development host cannot execute Linux namespaces. A separate Ubuntu CI runner subsequently passed the measured containment checks recorded below. Do not remove the wrapper to claim a contained run on an unsupported host: a failure must remain an operational failure. Ordinary local synthetic subprocess tests do not establish namespace containment.

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
There is no per-job process-count/cgroup quota in this launcher. The file-size ceiling
is 128 MiB, matching admitted source snapshots; the probe includes a valid synthetic
PNG above 32 MiB to catch accidental rejection of that admitted input range.

The same run executes the real vision worker on a committed synthetic image, rejects
a malformed synthetic image without issuing a finding, and creates a real unsigned,
review-required redaction while checking source and derivative hashes. The sanitized
JSON records host/kernel/tool/source identity, each check, and a static failure stage.
It contains neither environment values nor private key material. Fixed native-tool version
diagnostics and bounded synthetic-only failure tracebacks are retained for diagnosis.
A pass verifies only these measured synthetic decoder boundaries on that host; it does
not establish general malicious-decoder exploit resistance, physical accuracy, pilot
readiness, or containment of the separate ZK and witness processes.

The launcher now mounts an exact `/opt` base-Python installation when a venv points
there (as with GitHub setup-python), validates exact job inputs and output boundaries,
and rejects signing-key arguments. Exact public BLAS/LAPACK alternative aliases may
be read-only bound to validated library files under `/usr/lib` or `/lib`; the host
`/etc/alternatives` directory is not mounted. Vision process limits clamp to inherited
ceilings rather than attempting to raise Bubblewrap's stricter CPU/file-size limits.

### Observed Linux result and retained failures

On 2026-10-12 at 01:05:53 UTC, source `501280b2a59900f6f861c48327828ffc59138465`
passed all 23 reported checks on Ubuntu 22.04, kernel `6.8.0-1064-azure`, Bubblewrap
`0.6.1` in [decoder job 114621994436](https://github.com/thepackproof/packproof-v2/actions/runs/38190471528/job/114621994436).
The job completed successfully at 01:06:00 UTC. Cancellation of the remaining obsolete
backend job in the parent workflow does not turn this job result into a full-workflow pass.

The measured result includes separate mount/user/PID/network namespaces, denied host
loopback access, an empty IPv4 external routing table, hidden unrelated host files and
`/etc/passwd`, read-only code/runtime, and writable private job/temporary storage. Actual
allocation, file-growth and descriptor-exhaustion attempts were denied under the
reported 2-GiB address-space, 128-MiB file and 128-descriptor ceilings. The 55-second CPU
ceiling was inspected, not exhausted. No aggregate memory/disk quota, process-count
limit, seccomp policy or timeout-kill adversarial test is claimed by this probe.

The real vision worker accepted a valid 34,603,138-byte synthetic PNG and preserved its
source digest. Malformed media failed without findings. The real still-image redaction
worker produced an unsigned, review-required derivative with verified source/output
digests. Tesseract 4.1.1 executable and explicitly selected English trained-data hashes
were recorded; `approvedRuntime` remains false. The probe does not establish OCR
accuracy, video-redaction containment, consented-media performance or deployment readiness.

Failures are retained separately: source `39a82c5` at 00:53:49 UTC passed its hostile
boundary checks but failed redaction; source `406c8c9` at 00:58:34 UTC stopped on the OCR
provenance assertion before redaction. Source `64bf401` at 01:02:58 UTC then captured the
actual `ffprobe` exit 127 from unresolved `libblas.so.3`, plus Tesseract 4's legacy language
listing without a directory. The library-alias and explicit OCR-directory fixes were
validated by the subsequent `501280b` run. These are distinct evidence checkpoints,
not retroactive passes for the failed sources.

## Isolated container startup gate

```sh
docker build -f research/backend.Dockerfile -t packproof-rnd-smoke .
node research/container-smoke.mjs packproof-rnd-smoke --report /tmp/rnd-container-report.json
```

The dedicated image includes the PGlite runtime dependency and starts as UID 1000 with a private writable `/research/session` directory. Its entrypoint creates a new local research key and database on first start, reuses them on restart, and strips inherited cloud/service settings. All optional feature flags remain off. The smoke gate uses Docker's `none` network, exercises health and authenticated research capability access from inside the container, and checks database identity survives restart. It does not exercise decoders, native capture, external trust or deployment. The API stays bound to container loopback: ordinary port publishing is intentionally ineffective. For an interactive local Linux host, explicitly use host networking; do not change the API to a public listener. Container filesystem storage is retained only while that container exists; mount a private UID-1000-owned volume at `/research` for a deliberate persistent local setup. Never mount production data or credentials.
