# Local research runtime

No R&D surface is configured to distribute. Use a separate local database, local object directory, local development identities and newly generated research signing keys. All four feature controls and the global kill switch default closed. `config/rnd/local.env.example` is a template, not an enabled environment.

The backend TypeScript build imports the versioned contracts from the repository root. `research/backend.Dockerfile` uses that root build context; it is separate from the protected production image recipe. It was source-reviewed, not built here (Docker was unavailable). This image does not contain decoder environments and cannot run image jobs until an explicitly configured worker is available. Do not add cloud credentials to it.

## Decoder containment

`scripts/rnd-worker-sandbox.mjs` is a fail-closed Bubblewrap launcher for Linux hosts with unprivileged namespaces and proc mounts permitted. Set the absolute executable path as `PACKPROOF_RND_SANDBOX_EXECUTABLE` and a JSON argument array as `PACKPROOF_RND_SANDBOX_ARGS`, for example:

```text
["--runtime","/opt/packproof-vision","--code","/app/research","--"]
```

The Python executable must belong to that venv. The research code directory and interpreter are read-only; only the backend-owned mode-0700 job directory is writable. The launcher mounts neither the host root nor homes nor cloud configuration, clears the environment, creates separate PID/network/user namespaces, drops capabilities, and enforces process limits. It only permits the vision and redaction entry points. Source files are privately materialized and verified by digest before decoding. The parent kills the process group on timeout and deletes the job directory after completion or failure. Proving and witness processes have distinct trust/credential requirements and must use their own isolated service profiles.

This environment rejected Bubblewrap's proc mount (`Operation not permitted`), including the permitted elevated check. Therefore **namespace containment is implemented but not validated on this host**. Do not remove the wrapper to claim a contained run: a failure must remain an operational failure. The explicitly documented local synthetic harness uses bounded subprocesses without network namespaces; its measurements are not decoder-isolation qualification.

Before consented pilots, execute the actual worker under this wrapper on the target Linux host, verify that external network access and unrelated files are unavailable, run malicious decoder/resource fixtures, and record the host kernel, Bubblewrap version and results. No pilot or production decoder isolation is certified by this branch.
