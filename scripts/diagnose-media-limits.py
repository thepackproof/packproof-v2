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

# Exercise the exact bounded decoder/encoder paths, not just loader startup.
import tempfile
with tempfile.TemporaryDirectory(prefix="packproof-native-media-") as temporary:
    directory = Path(temporary)
    image = directory / "source.png"
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                    "color=c=red:s=32x32", "-threads", "1", "-frames:v", "1", str(image)],
                   env=env, check=True, capture_output=True, timeout=20)
    for megabytes in (512, 768, 1024):
        for name, source, transform in (
            ("redaction", image, "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill"),
            ("thumbnail", fixture, "scale=320:-2"),
        ):
            output = directory / f"{name}-{megabytes}.png"
            command = ["prlimit", f"--as={megabytes * 1024 * 1024}", "--cpu=15",
                       "--fsize=2097152", "--nofile=64", "--", "ffmpeg", "-nostdin",
                       "-v", "error", "-threads", "1", "-filter_threads", "1", "-y",
                       "-protocol_whitelist", "file,pipe", "-i", str(source), "-map", "0:v:0",
                       "-threads", "1", "-frames:v", "1", "-vf", transform, "-an", "-sn", "-dn",
                       "-map_metadata", "-1", "-map_chapters", "-1", str(output)]
            result = subprocess.run(command, env=env, capture_output=True, timeout=20)
            print(f"FFMPEG_AS_MB={megabytes} CASE={name} EXIT={result.returncode}", flush=True)
            print(result.stderr.decode("utf-8", "replace")[:4000], flush=True)
