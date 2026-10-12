"""Offline physical-study preparation and intake. Never operates a device or qualifies a claim."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import random
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path, PureWindowsPath

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "benchmarks" / "configs"
PLAN = "physical-corpus-240-60-v1.json"
POLICY = "physical-qualification-v1.json"
SCHEMA = "packproof.physical-intake.v1"
STUDIES = {"STAGE0_PASSIVE", "F01_OPTICAL", "F01_SECURITY", "F04_METROLOGY", "F06_REPLAY", "F08_PASSIVE_COMPARISON"}
STATUSES = {"RECORDED", "FAILED", "EXCLUDED", "NOT_RUN"}
PAIR_METRICS = ("durationMs", "batteryUsedPercentagePoints", "peakMemoryMiB", "peakTemperatureC", "frameGapCount", "droppedFrameCount", "readableDetails", "totalDetails")
LIMITS = [
    "Hashes establish local byte identity only; no decoder, sensor, consent-authority, ground-truth or calibration authentication is performed.",
    "Completeness does not establish physical independence, a security error bound, utility, safety, metrological traceability or release eligibility.",
    "No active illumination, focus or exposure driver is enabled. F08 control-policy qualification remains blocked.",
    "Same-device pilot data cannot be relabeled as cross-device or held-out-domain evidence.",
]


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load(path: Path) -> tuple[dict, str]:
    if path.stat().st_size > 10 * 1024 * 1024:
        raise ValueError("metadata exceeds 10 MiB")
    raw = path.read_bytes()
    def no_constant(value):
        raise ValueError("non-finite JSON number")
    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    result = json.loads(raw, parse_constant=no_constant, object_pairs_hook=unique_keys)
    if not isinstance(result, dict):
        raise ValueError("metadata must be a JSON object")
    return result, digest(raw)


def write_json(path: Path, data: dict) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(data, handle, indent=2, sort_keys=True, allow_nan=False)
        handle.write("\n")


def references() -> tuple[dict, dict, dict]:
    plan, plan_sha = load(CONFIG / PLAN)
    expected = (CONFIG / (PLAN + ".sha256")).read_text().split()[0]
    if plan_sha != expected:
        raise ValueError("frozen corpus template byte hash changed")
    policy, policy_sha = load(CONFIG / POLICY)
    return plan, policy, {PLAN: plan_sha, POLICY: policy_sha}


def utc(value: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError("timestamp must be an ISO 8601 string with timezone")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp requires a timezone")
    return parsed.astimezone(timezone.utc)


def identifier(value, field: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}", value):
        raise ValueError(field + " requires a nonempty pseudonymous identifier")
    return value


def finite(value, field: str, minimum=0, maximum=None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(field + " must be finite numeric data")
    if value < minimum or (maximum is not None and value > maximum):
        raise ValueError(field + " outside allowed range")
    return float(value)


def checked_artifact(ref: dict, private_root: Path) -> dict:
    """Only explicitly named files below the private root; no absolute, ADS or linked paths."""
    name = ref.get("path")
    if not isinstance(name, str) or not name or "\\" in name or ":" in name:
        raise ValueError("artifact path must be a relative slash-separated path")
    relative = Path(name)
    if name.startswith("/") or relative.is_absolute() or PureWindowsPath(name).is_absolute() or ".." in relative.parts:
        raise ValueError("artifact path escapes private root")
    root = private_root.resolve(strict=True)
    candidate = root
    for component in relative.parts:
        candidate = candidate / component
        if candidate.is_symlink() or (hasattr(candidate, "is_junction") and candidate.is_junction()):
            raise ValueError("linked artifact paths are forbidden")
    resolved = candidate.resolve(strict=True)
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise ValueError("artifact must be a regular file below private root")
    expected = ref.get("sha256")
    if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise ValueError("artifact requires a lowercase SHA-256")
    size = ref.get("byteLength")
    if isinstance(size, bool) or not isinstance(size, int) or not 0 < size <= 16 * 1024**3:
        raise ValueError("artifact byteLength must be between 1 byte and 16 GiB")
    if resolved.stat().st_size != size:
        raise ValueError("artifact byte length mismatch")
    actual = hashlib.sha256()
    with resolved.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            actual.update(block)
    if actual.hexdigest() != expected:
        raise ValueError("artifact byte hash mismatch")
    # Output deliberately omits local filenames and private contents.
    return {"sha256": expected, "byteLength": size}


def paired_schedule(pair_count: int, seed: int) -> list[dict]:
    if isinstance(pair_count, bool) or not 2 <= pair_count <= 1000 or pair_count % 2:
        raise ValueError("use an even pair count between 2 and 1000 for balanced order")
    rng = random.Random(seed)
    orders = [("OFF", "PASSIVE_ON")] * (pair_count // 2) + [("PASSIVE_ON", "OFF")] * (pair_count // 2)
    rng.shuffle(orders)
    return [{"pairId": f"PAIR-{i + 1:03}", "position": position + 1, "variant": variant,
             "attemptId": f"PAIR-{i + 1:03}-{position + 1}"}
            for i, order in enumerate(orders) for position, variant in enumerate(order)]


def prepare(output: Path) -> dict:
    plan, policy, hashes = references()
    output.mkdir(parents=True, exist_ok=False)
    protocol = {
        "schemaVersion": SCHEMA, "studyId": "s24-passive-preflight", "study": "STAGE0_PASSIVE",
        "dataOrigin": "physical-consented", "referenceDigests": hashes,
        "evaluationDataAccessed": False,
        "controls": {"mode": "PASSIVE_ONLY", "activeIllumination": False, "automaticFocus": False, "automaticExposure": False},
        "devices": [{"deviceId": "", "model": "Galaxy S24 Ultra", "osBuild": "", "appBuildSha256": "", "nativeStreamProfile": ""}],
        "operators": [{"operatorId": "", "consentArtifactId": ""}],
        "artifacts": {}, "protocolReviewArtifactId": "", "retentionUntil": "",
        "plannedAttempts": [{"attemptId": f"BASELINE-{n:02}", "deviceId": "", "operatorId": "",
                             "physicalInstanceId": "", "conditionId": "ordinary-room-light", "variant": "OFF",
                             "split": "pilot", "captureMode": "ORDINARY_CONTINUOUS_VIDEO"} for n in range(1, 4)],
    }
    write_json(output / "protocol-template.json", protocol)
    write_json(output / "session-intake-template.json", {"schemaVersion": SCHEMA, "protocolSha256": "", "records": []})
    allocation_fields = ["kind", "plannedId", "split", "technologyOrMaterial", "mediaLot", "printerUnit", "condition"]
    with (output / "specimen-allocation-reference.csv").open("x", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=allocation_fields); writer.writeheader()
        for row in plan["plannedLabels"]:
            writer.writerow(dict(kind="LABEL", plannedId=row["plannedPrintInstanceId"], split=row["split"],
                                 technologyOrMaterial=row["printTechnology"], mediaLot=row["plannedMediaLotId"], printerUnit=row["plannedPrinterUnitId"], condition="NOT_COLLECTED"))
        for row in plan["plannedCartons"]:
            writer.writerow(dict(kind="CARTON", plannedId=row["plannedCartonId"], split=row["split"],
                                 technologyOrMaterial=row["surfaceClass"], condition=row["condition"]))
    summary = {"schemaVersion": SCHEMA, "state": "PLANNED_ONLY_NOT_COLLECTED", "referenceDigests": hashes,
               "availableByUserDeclaration": ["Galaxy S24 Ultra", "desktop PC"], "measuredSessions": 0,
               "plannedLabelInstances": len(plan["plannedLabels"]), "plannedCartonInstances": len(plan["plannedCartons"]),
               "plannedMediaLots": len({r["plannedMediaLotId"] for r in plan["plannedLabels"]}),
               "plannedPrinterUnitSlots": len({r["plannedPrinterUnitId"] for r in plan["plannedLabels"]}),
               "requiredAttackFamilies": {f: policy[f]["requiredAttackFamilies"] for f in ("F01", "F04", "F06")},
               "blocked": ["protocol fields and consent/review artifacts incomplete", "no captured original files", "no qualified active control profile", "cross-device and independent studies not supplied"],
               "qualified": False, "releaseEligible": False, "limits": LIMITS}
    write_json(output / "preparation-receipt.json", summary)
    return summary


def validate_protocol(protocol: dict, private_root: Path) -> dict:
    if protocol.get("schemaVersion") != SCHEMA or protocol.get("study") not in STUDIES:
        raise ValueError("unknown physical intake schema or study; active control studies are unsupported")
    identifier(protocol.get("studyId"), "studyId")
    if protocol.get("dataOrigin") not in ("physical-consented", "synthetic-fixture"):
        raise ValueError("dataOrigin must distinguish physical consented data and synthetic fixtures")
    if protocol.get("evaluationDataAccessed") is not False:
        raise ValueError("protocol cannot be frozen after evaluation data access")
    if protocol.get("referenceDigests") != references()[2]:
        raise ValueError("reference policy or planned specimen hashes differ")
    if protocol.get("controls") != {"mode": "PASSIVE_ONLY", "activeIllumination": False, "automaticFocus": False, "automaticExposure": False} or any(protocol["controls"][key] is not False for key in ("activeIllumination", "automaticFocus", "automaticExposure")):
        raise ValueError("unqualified active controls are forbidden")
    artifacts = {identifier(key, "artifactId"): checked_artifact(value, private_root) for key, value in protocol.get("artifacts", {}).items()}
    if protocol.get("protocolReviewArtifactId") not in artifacts:
        raise ValueError("protocol review artifact required before acquisition")
    devices, operators = {}, {}
    for row in protocol.get("devices", []):
        key = identifier(row.get("deviceId"), "deviceId")
        if key in devices:
            raise ValueError("duplicate deviceId")
        for field in ("model", "osBuild", "nativeStreamProfile"):
            if not isinstance(row.get(field), str) or not row[field].strip():
                raise ValueError("device profile missing " + field)
        if not re.fullmatch(r"[a-f0-9]{64}", row.get("appBuildSha256", "")):
            raise ValueError("exact app build SHA-256 required")
        devices[key] = row
    for row in protocol.get("operators", []):
        key = identifier(row.get("operatorId"), "operatorId")
        if key in operators or row.get("consentArtifactId") not in artifacts:
            raise ValueError("unique operator and consent artifact required")
        operators[key] = row
    utc(protocol.get("retentionUntil"))
    attempts, pairs = {}, defaultdict(list)
    corpus = references()[0]
    label_slots = {row["plannedPrintInstanceId"]: row for row in corpus["plannedLabels"]}
    carton_slots = {row["plannedCartonId"]: row for row in corpus["plannedCartons"]}
    for row in protocol.get("plannedAttempts", []):
        key = identifier(row.get("attemptId"), "attemptId")
        if key in attempts:
            raise ValueError("duplicate planned attempt")
        for field in ("physicalInstanceId", "conditionId"):
            identifier(row.get(field), field)
        if row.get("deviceId") not in devices or row.get("operatorId") not in operators:
            raise ValueError("attempt requires an inventoried device and consented operator")
        if row.get("split") not in ("pilot", "train", "tune", "test"):
            raise ValueError("invalid split")
        if row.get("variant") not in ("OFF", "PASSIVE_ON"):
            raise ValueError("only ordinary baseline or passive feature variants are supported")
        if row.get("captureMode") not in ("ORDINARY_CONTINUOUS_VIDEO", "CONCURRENT_NATIVE_SELECTED_FRAME", "COACHED_LAB_CLOSEUP_SEPARATE"):
            raise ValueError("unknown capture mode")
        if protocol["study"] == "STAGE0_PASSIVE" and (row["variant"] != "OFF" or row["split"] != "pilot"):
            raise ValueError("Stage 0 is an ordinary baseline pilot only")
        if protocol["study"] in ("F01_OPTICAL", "F01_SECURITY", "F06_REPLAY", "F04_METROLOGY"):
            identifier(row.get("attackFamily"), "attackFamily")
        if protocol["study"] in ("F01_OPTICAL", "F01_SECURITY"):
            label = label_slots.get(row.get("plannedLabelId"))
            carton = carton_slots.get(row.get("plannedCartonId"))
            if not label or not carton:
                raise ValueError("F01 acquisition must reference existing planned label and carton slots")
            if row["split"] != label["split"] or row["split"] != carton["split"]:
                raise ValueError("planned specimen split differs; do not silently repartition the frozen population")
        if protocol["study"] == "F08_PASSIVE_COMPARISON":
            pairs[identifier(row.get("pairId"), "pairId")].append(row)
        attempts[key] = row
    if not attempts:
        raise ValueError("at least one acquisition must be planned before freezing")
    if pairs:
        expected = protocol.get("comparison", {}).get("expectedDetailsCount")
        if isinstance(expected, bool) or not isinstance(expected, int) or expected < 1:
            raise ValueError("comparison requires a frozen positive detail-count denominator")
    for rows in pairs.values():
        if len(rows) != 2 or {r["variant"] for r in rows} != {"OFF", "PASSIVE_ON"} or {r.get("position") for r in rows} != {1, 2}:
            raise ValueError("each comparison pair requires exactly OFF and PASSIVE_ON at positions 1 and 2")
        for field in ("deviceId", "operatorId", "physicalInstanceId", "conditionId", "split", "captureMode"):
            if len({r[field] for r in rows}) != 1:
                raise ValueError("comparison pair mismatch: " + field)
    return {"artifacts": artifacts, "devices": devices, "attempts": attempts}


def freeze(protocol_path: Path, private_root: Path, output: Path, now=None) -> dict:
    protocol, sha = load(protocol_path)
    result = validate_protocol(protocol, private_root)
    now = now or datetime.now(timezone.utc)
    if utc(protocol["retentionUntil"]) <= now:
        raise ValueError("retention deadline has expired")
    receipt = {"schemaVersion": SCHEMA, "protocolSha256": sha, "frozenAt": now.isoformat(),
               "artifactBindings": result["artifacts"], "plannedAttempts": len(result["attempts"]),
               "qualified": False, "releaseEligible": False,
               "limits": LIMITS + ["A local freeze file is not an external timestamp, signature or proof of prior non-access. Preserve it with the independent protocol reviewer."]}
    write_json(output, receipt)
    return receipt


def inspect_intake(protocol_path: Path, freeze_path: Path, intake_path: Path, private_root: Path, now=None) -> dict:
    protocol, sha = load(protocol_path); frozen, _ = load(freeze_path); intake, intake_sha = load(intake_path)
    if frozen.get("schemaVersion") != SCHEMA or intake.get("schemaVersion") != SCHEMA or frozen.get("protocolSha256") != sha or intake.get("protocolSha256") != sha:
        raise ValueError("intake/freeze does not bind the exact protocol bytes")
    plan = validate_protocol(protocol, private_root)
    if frozen.get("artifactBindings") != plan["artifacts"] or frozen.get("plannedAttempts") != len(plan["attempts"]):
        raise ValueError("frozen artifact or attempt bindings changed")
    now = now or datetime.now(timezone.utc)
    if utc(protocol["retentionUntil"]) <= now:
        raise ValueError("retention expired; do not process the private study")
    frozen_at = utc(frozen["frozenAt"])
    if frozen_at > now:
        raise ValueError("freeze timestamp is in the future")
    records, sources, counts, missing, findings, measurements = {}, {}, Counter(), [], [], []
    for record in intake.get("records", []):
        key = record.get("attemptId")
        if key not in plan["attempts"] or key in records:
            raise ValueError("unknown or duplicate acquisition attempt")
        if record.get("status") not in STATUSES:
            raise ValueError("unknown acquisition status")
        if record["status"] != "RECORDED" and not str(record.get("reason", "")).strip():
            raise ValueError("failed, excluded and not-run attempts require a reason")
        if record.get("source") is not None:
            bound = checked_artifact(record["source"], private_root)
            if bound["sha256"] in sources:
                raise ValueError("one original source reused across acquisitions; keep derived frames under the original acquisition")
            sources[bound["sha256"]] = key
        elif record["status"] == "RECORDED":
            raise ValueError("recorded acquisition requires original source bytes")
        if record["status"] == "RECORDED":
            if not frozen_at < utc(record.get("startedAt")) <= utc(record.get("endedAt")) <= now:
                raise ValueError("acquisition timestamps must follow the freeze and cannot be in the future")
            identifier(record.get("captureSessionId"), "captureSessionId")
            if record.get("nativeStreamProfile") != plan["devices"][plan["attempts"][key]["deviceId"]]["nativeStreamProfile"]:
                raise ValueError("actual native stream profile differs from frozen profile")
            if record.get("controls") != protocol["controls"] or any(record["controls"][key] is not False for key in ("activeIllumination", "automaticFocus", "automaticExposure")):
                raise ValueError("actual controls differ from the passive protocol")
            if not isinstance(record.get("recordingInterruptions"), int) or isinstance(record["recordingInterruptions"], bool) or record["recordingInterruptions"] < 0:
                raise ValueError("recording interruptions must be counted")
            if record["recordingInterruptions"]:
                findings.append({"attemptId": key, "finding": "INTERRUPTED_RECORDING_RETAINED"})
            if protocol["study"] == "F04_METROLOGY":
                values = record.get("metrology", {})
                if values.get("unit") != "mm" or values.get("calibrationArtifactId") not in plan["artifacts"]:
                    raise ValueError("metrology requires mm and a frozen calibration artifact")
                reference = finite(values.get("referenceMm"), "referenceMm", minimum=0.000001)
                estimate = finite(values.get("reconstructedMm"), "reconstructedMm")
                uncertainty = finite(values.get("referenceUncertaintyMm"), "referenceUncertaintyMm")
                error = abs(estimate - reference); tolerance = max(5, reference * .02)
                measurements.append({"attemptId": key, "absoluteErrorMm": error, "referenceUncertaintyMm": uncertainty,
                                     "declaredToleranceMm": tolerance, "errorPlusReferenceUncertaintyWithinTolerance": error + uncertainty <= tolerance,
                                     "metrologicallyQualified": False})
        records[key] = record
    for key in plan["attempts"]:
        status = records.get(key, {}).get("status", "NOT_RUN")
        counts[status] += 1
        if status != "RECORDED":
            missing.append({"attemptId": key, "status": status})
    # Report all declared split conflicts; never export these records as a qualified manifest.
    splits = defaultdict(set)
    policy = references()[1]
    for key, attempt in plan["attempts"].items():
        if attempt["split"] == "pilot":
            continue
        for field in policy["holdoutDimensions"]:
            value = attempt.get(field) or records.get(key, {}).get(field)
            if field == "sourceDigest" and records.get(key, {}).get("source"):
                value = records[key]["source"]["sha256"]
            if value:
                splits[(field, str(value))].add(attempt["split"])
            else:
                findings.append({"attemptId": key, "finding": "HOLDOUT_ID_MISSING", "field": field})
    for (field, _), values in splits.items():
        if len(values) > 1:
            findings.append({"finding": "CROSS_SPLIT_REUSE", "field": field, "splits": sorted(values)})
    pairs = []
    if protocol["study"] == "F08_PASSIVE_COMPARISON":
        grouped = defaultdict(list)
        for attempt in plan["attempts"].values():
            grouped[attempt["pairId"]].append(attempt)
        for key, attempts in grouped.items():
            arms = {a["variant"]: records.get(a["attemptId"], {}) for a in attempts}
            missing_metrics, metrics = [], {}
            for arm, record in arms.items():
                if record.get("status") != "RECORDED":
                    missing_metrics.append(arm + ":acquisition_unavailable"); continue
                raw = record.get("metrics", {})
                metrics[arm] = {}
                for name in PAIR_METRICS:
                    if name not in raw:
                        missing_metrics.append(arm + ":" + name)
                    else:
                        metrics[arm][name] = finite(raw[name], name, minimum=-30 if name == "peakTemperatureC" else 0, maximum=100 if name == "batteryUsedPercentagePoints" else None)
                if "readableDetails" in raw and "totalDetails" in raw and raw["readableDetails"] > raw["totalDetails"]:
                    raise ValueError("readable details cannot exceed the frozen review denominator")
                if "totalDetails" in raw and raw["totalDetails"] != protocol["comparison"]["expectedDetailsCount"]:
                    raise ValueError("review denominator differs from frozen detail count")
                for name in ("frameGapCount", "droppedFrameCount", "readableDetails", "totalDetails"):
                    if name in raw and (isinstance(raw[name], bool) or not isinstance(raw[name], int)):
                        raise ValueError(name + " must be an integer count")
                for artifact_name in ("decoderReport", "blindedReview"):
                    if not record.get(artifact_name):
                        missing_metrics.append(arm + ":" + artifact_name)
                    else:
                        checked_artifact(record[artifact_name], private_root)
            row = {"pairId": key, "complete": not missing_metrics, "missing": missing_metrics}
            if not missing_metrics:
                row["passiveOnMinusOff"] = {name: metrics["PASSIVE_ON"][name] - metrics["OFF"][name] for name in PAIR_METRICS}
            pairs.append(row)
    complete = not missing and not findings and all(row["complete"] for row in pairs)
    return {"schemaVersion": SCHEMA, "state": "INTAKE_COMPLETE_NOT_QUALIFIED" if complete else "INCOMPLETE_OR_REVIEW_REQUIRED",
            "protocolSha256": sha, "intakeSha256": intake_sha, "study": protocol["study"], "dataOrigin": protocol["dataOrigin"],
            "plannedAttempts": len(plan["attempts"]), "denominators": {key: counts[key] for key in sorted(STATUSES)},
            "verifiedOriginalFiles": len(sources), "unavailableAcquisitions": missing, "findings": findings,
            "metrology": measurements, "pairs": pairs, "qualified": False, "releaseEligible": False, "limits": LIMITS}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare"); prep.add_argument("--output", type=Path, required=True)
    schedule = commands.add_parser("pair-schedule"); schedule.add_argument("--pairs", type=int, required=True); schedule.add_argument("--seed", type=int, required=True); schedule.add_argument("--output", type=Path, required=True)
    for command in ("freeze", "validate"):
        sub = commands.add_parser(command); sub.add_argument("--protocol", type=Path, required=True); sub.add_argument("--private-root", type=Path, required=True); sub.add_argument("--output", type=Path, required=True)
        if command == "validate":
            sub.add_argument("--freeze", type=Path, required=True); sub.add_argument("--intake", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            result = prepare(args.output)
        elif args.command == "pair-schedule":
            result = {"schemaVersion": SCHEMA, "state": "PLANNED_ONLY_NOT_COLLECTED", "seed": args.seed, "schedule": paired_schedule(args.pairs, args.seed), "qualified": False}
            write_json(args.output, result)
        elif args.command == "freeze":
            result = freeze(args.protocol, args.private_root, args.output)
        else:
            result = inspect_intake(args.protocol, args.freeze, args.intake, args.private_root)
            write_json(args.output, result)
        print(json.dumps({"output": str(args.output), "state": result.get("state", "FROZEN_LOCAL_DECLARATION"), "qualified": False}))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as exc:
        parser.exit(2, "intake rejected: " + str(exc) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
