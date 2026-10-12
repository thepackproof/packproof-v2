"""Create an explicitly synthetic four-case dry run; no human-study result is generated."""
import argparse
import hashlib
import json
from pathlib import Path


def create(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    cases = []
    for feature in ("F03", "F05"):
        for i in range(2):
            cid = f"synthetic-{feature}-{i}"
            files = []
            for slot in ("original", "support"):
                name = f"{cid}-{slot}.txt"
                body = (f"SYNTHETIC SOFTWARE FIXTURE {cid}, {slot}. Not a real capture.\n"
                        + ("Example timeline: LABEL_VISIBLE at 1000-2000 ms.\n" if feature == "F03"
                           else "Example recorded identifier: LEFT=DEMO123, RIGHT=DEMO123.\n")).encode()
                (directory / name).write_bytes(body)
                files.append({"slot": slot, "path": name, "sha256": hashlib.sha256(body).hexdigest(),
                              "byteLength": len(body), "mimeType": "text/plain", "durationMs": 3000})
            cases.append({"caseId": cid, "feature": feature, "stratum": "software-fixture", "split": "test",
                "specimenIds": [f"fixture-object-{cid}"], "captureSessionIds": [f"fixture-session-{cid}"],
                "originals": [files[0]], "enrichment": [files[1]],
                "question": {"target": "LABEL_VISIBLE" if feature == "F03" else "identifier"},
                "reference": {"state": "RESOLVED", "value": "OBSERVED" if feature == "F03" else "OBSERVED_VALUES_EQUAL",
                    "contradiction": False, "acceptableWindows": [{"slot": "original", "startMs": 1000, "endMs": 2000}] if feature == "F03" else [],
                    "annotationDigest": hashlib.sha256(f"synthetic annotation {cid}".encode()).hexdigest()}})
    manifest = {"schemaVersion": "packproof.reviewer-study.v1", "studyId": "synthetic-dry-run",
        "dataOrigin": "SYNTHETIC", "policy": {"version": "dry-run-only", "reviewerCount": 4,
            "seed": "0123456789abcdef" * 4, "timeLimitSeconds": 120, "eventToleranceMs": 250,
            "frozenBeforeReview": True}, "cases": cases}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    create(parser.parse_args().output)
    print("SYNTHETIC inputs created. No participants or study outcomes were generated.")
