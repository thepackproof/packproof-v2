"""One bounded job per process. stdout is exactly one JSON result without logs."""
import argparse
import json
import os
import sys
from pathlib import Path
from .contracts import InputError, canonical, read_json

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output")
    parser.add_argument("--media-root", required=True)
    args = parser.parse_args()
    try:
        # Apply these before importing NumPy/OpenCV (also enforce via container).
        os.environ["OPENBLAS_NUM_THREADS"] = "1"
        os.environ["OMP_NUM_THREADS"] = "1"
        os.environ["OPENCV_IO_MAX_IMAGE_PIXELS"] = "16000000"
        os.environ["OPENCV_IO_MAX_IMAGE_WIDTH"] = "8192"
        os.environ["OPENCV_IO_MAX_IMAGE_HEIGHT"] = "8192"
        try:
            import resource
            resource.setrlimit(resource.RLIMIT_AS, (1536 * 1024 * 1024, 1536 * 1024 * 1024))
            resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
            resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024, 16 * 1024 * 1024))
            resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
        except ImportError:
            pass  # Windows caller must impose job-object limits; Linux container is reference.
        from .engine import run
        result = run(read_json(args.input), args.media_root)
        encoded = canonical(result) + b"\n"
        if args.output:
            path = Path(args.output)
            temporary = path.with_name(path.name + ".tmp")
            with open(temporary, "xb") as f:
                f.write(encoded)
            os.replace(temporary, path)
        else:
            sys.stdout.buffer.write(encoded)
        return 0
    except Exception as exc:
        # Operational errors are not physical discrepancies and must never become evidence findings.
        sys.stderr.write(json.dumps({"schemaVersion": "surface-error/1", "status": "error", "code": "INVALID_JOB_OR_MEDIA", "message": str(exc)[:240]}) + "\n")
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
