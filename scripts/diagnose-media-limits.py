"""Source-bound media diagnostics. Never reads application credentials or customer media."""
import os
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
env = {"PATH": os.environ.get("PATH", ""), "LANG": "C",
       "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"}
fixture = root / "backend/tests/fixtures/camera-recording.mp4"
for megabytes in (512, 768, 1024):
    command = ["prlimit", f"--as={megabytes * 1024 * 1024}", "--cpu=15",
               "--fsize=4194304", "--nofile=64", "--", "ffprobe",
               "-v", "error", "-protocol_whitelist", "file,pipe",
               "-show_entries", "format=duration", "-of", "json", str(fixture)]
    result = subprocess.run(command, env=env, capture_output=True, timeout=20)
    print(f"FFPROBE_AS_MB={megabytes} EXIT={result.returncode}", flush=True)
    print(result.stdout.decode("utf-8", "replace")[:2000], flush=True)
    print(result.stderr.decode("utf-8", "replace")[:4000], flush=True)
