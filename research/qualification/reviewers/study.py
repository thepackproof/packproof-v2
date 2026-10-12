"""Offline, outcome-blinded reviewer study preparation and descriptive scoring.

No dependencies, network, model training, qualification thresholds or release authority.
The coordinator input/key are private; hand each reviewer only their packet directory.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import random
import re
import shutil
import statistics
import sys

SCHEMA = "packproof.reviewer-study.v1"
EVENTS = {"LABEL_VISIBLE", "IDENTIFIER_OBSERVED", "ITEM_TRACK_STARTED", "ITEM_VISIBILITY_LOST",
          "CONTAINER_VISIBLE", "ITEM_CROSSES_OPENING", "CLOSURE_ACTION_VISIBLE", "SEAM_VISIBLE",
          "RECORDING_INTERRUPTED", "POSSIBLE_REOPENING"}
CHANNELS = {"identifier", "tracking", "weight", "appearance", "surface", "condition", "provenance"}
EVENT_VALUES = {"OBSERVED", "NOT_OBSERVED", "NOT_ASSESSABLE"}
MATRIX_VALUES = {"OBSERVED_VALUES_EQUAL", "OBSERVED_VALUES_DIFFER", "MISSING_VALUE",
                 "CONFLICTING_VALUES", "INCONCLUSIVE"}
MIMES = {"video/mp4": ".mp4", "image/png": ".png", "image/jpeg": ".jpg",
         "application/json": ".json", "text/plain": ".txt"}
ID = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")
SHA = re.compile(r"[a-f0-9]{64}\Z")
LIMIT = 8 * 1024 * 1024


def require(condition, code):
    if not condition:
        raise ValueError(code)


def keys(value, allowed, required=None):
    require(isinstance(value, dict) and not set(value) - set(allowed), "UNEXPECTED_FIELDS")
    require(set(required if required is not None else allowed) <= set(value), "MISSING_FIELDS")


def identifier(value):
    require(isinstance(value, str) and ID.fullmatch(value), "OPAQUE_ID_REQUIRED")
    return value


def number(value, low, high):
    require(type(value) in (int, float) and math.isfinite(value) and low <= value <= high, "INVALID_NUMBER")
    return value


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def load(path):
    path = Path(path)
    require(path.stat().st_size <= LIMIT, "JSON_SIZE_LIMIT")
    def distinct(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "DUPLICATE_JSON_KEY")
            result[key] = value
        return result
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=distinct,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("NONFINITE_JSON")))


def write(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as target:
        json.dump(value, target, indent=2, allow_nan=False)
        target.write("\n")


def token(seed, purpose):
    return hmac.new(bytes.fromhex(seed), purpose.encode(), hashlib.sha256).hexdigest()[:24]


def validate(manifest):
    keys(manifest, ["schemaVersion", "studyId", "dataOrigin", "policy", "cases"])
    require(manifest["schemaVersion"] == SCHEMA, "SCHEMA_MISMATCH")
    identifier(manifest["studyId"])
    require(manifest["dataOrigin"] in ("SYNTHETIC", "CONSENTED_RESEARCH"), "DATA_ORIGIN_REQUIRED")
    policy = manifest["policy"]
    keys(policy, ["version", "reviewerCount", "seed", "timeLimitSeconds", "eventToleranceMs", "frozenBeforeReview"])
    identifier(policy["version"])
    count = policy["reviewerCount"]
    require(type(count) is int and 4 <= count <= 64 and count % 2 == 0, "EVEN_REVIEWER_COUNT_4_TO_64")
    require(isinstance(policy["seed"], str) and SHA.fullmatch(policy["seed"]), "PRIVATE_SEED_REQUIRED")
    number(policy["timeLimitSeconds"], 10, 3600)
    number(policy["eventToleranceMs"], 0, 60000)
    require(policy["frozenBeforeReview"] is True, "POLICY_FREEZE_REQUIRED")
    require(isinstance(manifest["cases"], list) and 2 <= len(manifest["cases"]) <= 400, "CASE_LIMIT")
    ids, lineage, test_lineage, groups = set(), {}, {}, defaultdict(list)
    for case in manifest["cases"]:
        keys(case, ["caseId", "feature", "stratum", "split", "specimenIds", "captureSessionIds",
                    "originals", "enrichment", "question", "reference"])
        cid = identifier(case["caseId"])
        require(cid not in ids, "DUPLICATE_CASE")
        ids.add(cid)
        require(case["feature"] in ("F03", "F05") and case["split"] in ("train", "tune", "test"), "CASE_SCOPE")
        identifier(case["stratum"])
        bindings = []
        for field in ("specimenIds", "captureSessionIds"):
            values = case[field]
            require(isinstance(values, list) and 1 <= len(values) <= 16 and len(set(values)) == len(values), "LINEAGE_REQUIRED")
            bindings.extend((field, identifier(v)) for v in values)
        assets = case["originals"] + case["enrichment"] if isinstance(case["originals"], list) and isinstance(case["enrichment"], list) else []
        require(1 <= len(case["originals"]) <= 8 and 1 <= len(case["enrichment"]) <= 8 and assets, "BOTH_PRESENTATIONS_REQUIRED")
        slots = set()
        for asset in assets:
            keys(asset, ["slot", "path", "sha256", "byteLength", "mimeType", "durationMs"])
            slot = identifier(asset["slot"])
            require(slot not in slots, "DUPLICATE_ASSET_SLOT")
            slots.add(slot)
            require(isinstance(asset["path"], str) and 1 <= len(asset["path"]) <= 500, "LOCAL_ASSET_PATH_REQUIRED")
            require(isinstance(asset["sha256"], str) and SHA.fullmatch(asset["sha256"]), "ASSET_HASH_REQUIRED")
            require(type(asset["byteLength"]) is int and 1 <= asset["byteLength"] <= 256 * 1024 * 1024, "ASSET_SIZE_LIMIT")
            require(asset["mimeType"] in MIMES, "UNSUPPORTED_ASSET_TYPE")
            number(asset["durationMs"], 0, 86400000)
            # Derived enrichment must not make a held-out source available in training either.
            bindings.append(("sourceDigest", asset["sha256"]))
        for binding in bindings:
            previous = lineage.setdefault(binding, case["split"])
            require(previous == case["split"], "SOURCE_OR_SPECIMEN_SPLIT_LEAKAGE")
            if case["split"] == "test":
                require(test_lineage.setdefault(binding, cid) == cid, "RELATED_TEST_CASES_REQUIRE_ONE_CASE")
        keys(case["question"], ["target"])
        require(case["question"]["target"] in (EVENTS if case["feature"] == "F03" else CHANNELS), "NEUTRAL_OBSERVATION_TARGET_REQUIRED")
        reference = case["reference"]
        keys(reference, ["state", "value", "contradiction", "acceptableWindows", "annotationDigest"])
        require(reference["state"] in ("RESOLVED", "DISPUTED"), "REFERENCE_STATE_REQUIRED")
        require(reference["value"] in (EVENT_VALUES if case["feature"] == "F03" else MATRIX_VALUES), "REFERENCE_VALUE_INVALID")
        require(type(reference["contradiction"]) is bool, "REFERENCE_CONTRADICTION_REQUIRED")
        require(isinstance(reference["annotationDigest"], str) and SHA.fullmatch(reference["annotationDigest"]), "INDEPENDENT_ANNOTATION_DIGEST_REQUIRED")
        windows = reference["acceptableWindows"]
        require(isinstance(windows, list) and len(windows) <= 20, "REFERENCE_WINDOW_LIMIT")
        original_by_slot = {a["slot"]: a for a in case["originals"]}
        for window in windows:
            keys(window, ["slot", "startMs", "endMs"])
            require(window["slot"] in original_by_slot, "REFERENCE_SOURCE_MISMATCH")
            number(window["startMs"], 0, original_by_slot[window["slot"]]["durationMs"])
            number(window["endMs"], window["startMs"], original_by_slot[window["slot"]]["durationMs"])
        require(bool(windows) == (case["feature"] == "F03" and reference["value"] == "OBSERVED"), "REFERENCE_WINDOW_REQUIRED_ONLY_FOR_OBSERVED_EVENT")
        if case["split"] == "test":
            groups[(case["feature"], case["stratum"])].append(case)
    require(groups and all(len(cases) % 2 == 0 for cases in groups.values()), "EVEN_TEST_CASES_PER_FEATURE_STRATUM")
    return groups


def make_plan(manifest):
    groups = validate(manifest)
    policy, assignments, packets = manifest["policy"], [], {}
    seed = policy["seed"]
    rng = random.Random(int(seed, 16))
    reviewer_tokens = [token(seed, f"reviewer:{i}") for i in range(policy["reviewerCount"])]
    rng.shuffle(reviewer_tokens)
    for reviewer in reviewer_tokens:
        packets[reviewer] = []
    for group in sorted(groups):
        cases = sorted(groups[group], key=lambda c: c["caseId"])
        rng.shuffle(cases)
        flip = rng.randrange(2)
        for position, case in enumerate(cases):
            for index, reviewer in enumerate(reviewer_tokens):
                enriched = bool((position + index + flip) % 2)
                aid = token(seed, f"assignment:{reviewer}:{case['caseId']}")
                assignment = {"assignmentId": aid, "reviewerToken": reviewer, "caseId": case["caseId"],
                              "condition": "ENRICHED" if enriched else "ORIGINAL_ONLY"}
                assignments.append(assignment)
                assets = [{"slot": a["slot"], "sha256": a["sha256"], "byteLength": a["byteLength"],
                           "mimeType": a["mimeType"], "durationMs": a["durationMs"]} for a in case["originals"]]
                if enriched:
                    assets.extend({"slot": a["slot"], "sha256": a["sha256"], "byteLength": a["byteLength"],
                                   "mimeType": a["mimeType"], "durationMs": a["durationMs"]} for a in case["enrichment"])
                packets[reviewer].append({"assignmentId": aid, "feature": case["feature"],
                    "target": case["question"]["target"], "assets": assets})
    for packet in packets.values():
        rng.shuffle(packet)
    return {"schemaVersion": SCHEMA, "manifestDigest": digest(manifest), "manifest": manifest,
            "assignments": assignments, "packets": packets, "qualified": False, "releaseAuthorized": False}


def file_sha256(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def verify_asset(root, asset):
    root = Path(root).resolve()
    relative = Path(asset["path"])
    require(not relative.is_absolute() and ".." not in relative.parts, "ASSET_OUTSIDE_PRIVATE_ROOT")
    candidate = root / relative
    require(candidate.resolve().is_relative_to(root), "ASSET_OUTSIDE_PRIVATE_ROOT")
    require(not any(p.is_symlink() for p in [candidate, *list(candidate.parents)[:len(relative.parts)-1]]), "ASSET_SYMLINK_REJECTED")
    require(candidate.is_file() and candidate.stat().st_size == asset["byteLength"], "ASSET_SIZE_MISMATCH")
    require(file_sha256(candidate) == asset["sha256"], "ASSET_DIGEST_MISMATCH")
    return candidate


def prepare(manifest, root, output, maximum_output_bytes=2 * 1024**3):
    plan = make_plan(manifest)
    cases = {c["caseId"]: c for c in manifest["cases"]}
    files, expected = {}, 0
    for assignment in plan["assignments"]:
        case = cases[assignment["caseId"]]
        assets = case["originals"] + (case["enrichment"] if assignment["condition"] == "ENRICHED" else [])
        for asset in assets:
            identity = (case["caseId"], asset["slot"])
            if identity not in files:
                files[identity] = verify_asset(root, asset)
            expected += asset["byteLength"]
    require(expected <= maximum_output_bytes, "PACKET_OUTPUT_BUDGET_EXCEEDED")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    (output / "coordinator").mkdir(mode=0o700)
    # Coordinator key and manifest are never put inside a reviewer packet.
    write(output / "coordinator" / "study-key.json", plan)
    assignments = {a["assignmentId"]: a for a in plan["assignments"]}
    for reviewer, tasks in plan["packets"].items():
        directory = output / "packets" / reviewer
        directory.mkdir(parents=True, mode=0o700)
        public = {"schemaVersion": SCHEMA, "manifestDigest": plan["manifestDigest"], "reviewerToken": reviewer,
                  "timeLimitSeconds": manifest["policy"]["timeLimitSeconds"], "tasks": []}
        for task in tasks:
            item = json.loads(json.dumps(task))
            cid = assignments[task["assignmentId"]]["caseId"]
            for asset in item["assets"]:
                # Slot and filename are generated, never original evidence/customer filenames.
                original_slot = asset["slot"]
                originals = cases[cid]["originals"]
                slot_index = next((i for i, a in enumerate(originals) if a["slot"] == original_slot), None)
                asset["slot"] = f"source-{slot_index+1}" if slot_index is not None else f"support-{len(item['assets'])}-{item['assets'].index(asset)+1}"
                filename = token(manifest["policy"]["seed"], f"asset:{task['assignmentId']}:{original_slot}") + MIMES[asset["mimeType"]]
                asset["file"] = filename
                shutil.copyfile(files[(cid, original_slot)], directory / filename)
                copied = file_sha256(directory / filename)
                require(copied == asset["sha256"], "COPIED_ASSET_CHANGED")
                if asset["mimeType"] in ("application/json", "text/plain"):
                    require(asset["byteLength"] <= 1024 * 1024, "DISPLAY_TEXT_LIMIT")
                    asset["text"] = (directory / filename).read_text(encoding="utf-8")
            public["tasks"].append(item)
        write(directory / "packet.json", public)
        (directory / "review.html").write_text(render_html(public), encoding="utf-8")
    write(output / "preparation-receipt.json", {"schemaVersion": SCHEMA, "manifestDigest": plan["manifestDigest"],
        "reviewerPackets": len(plan["packets"]), "assignments": len(plan["assignments"]),
        "copiedAssetBytes": expected, "dataOrigin": manifest["dataOrigin"], "qualified": False,
        "releaseAuthorized": False, "note": "Distribute each reviewer only their own packet, never coordinator/ or other packets. Blinding does not remove identities or annotations embedded in asset bytes."})
    return plan


def response_correct(case, response, tolerance):
    reference = case["reference"]
    if response["value"] != reference["value"] or response["contradiction"] != reference["contradiction"]:
        return False
    if case["feature"] == "F03" and reference["value"] == "OBSERVED":
        window = response["window"]
        if window is None:
            return False
        return any(window["slot"] == f"source-{next(i for i,a in enumerate(case['originals']) if a['slot']==r['slot'])+1}"
                   and abs(window["startMs"] - r["startMs"]) <= tolerance
                   and abs(window["endMs"] - r["endMs"]) <= tolerance
                   for r in reference["acceptableWindows"])
    return response["window"] is None


def score(plan, submissions):
    # Re-derive randomization instead of trusting edited coordinator assignments.
    expected = make_plan(plan["manifest"])
    require(plan == expected, "STUDY_KEY_CHANGED")
    cases = {c["caseId"]: c for c in plan["manifest"]["cases"]}
    assignments = {a["assignmentId"]: a for a in plan["assignments"]}
    responses = {}
    limit = plan["manifest"]["policy"]["timeLimitSeconds"]
    for submission in submissions:
        keys(submission, ["schemaVersion", "manifestDigest", "reviewerToken", "responses"])
        require(submission["schemaVersion"] == SCHEMA and submission["manifestDigest"] == plan["manifestDigest"], "RESPONSE_STUDY_MISMATCH")
        require(submission["reviewerToken"] in plan["packets"], "UNKNOWN_REVIEWER_TOKEN")
        require(isinstance(submission["responses"], list), "RESPONSE_ARRAY_REQUIRED")
        for response in submission["responses"]:
            keys(response, ["assignmentId", "status", "elapsedSeconds", "value", "contradiction", "window", "confidencePercent"])
            aid = response["assignmentId"]
            require(aid in assignments and assignments[aid]["reviewerToken"] == submission["reviewerToken"], "FOREIGN_ASSIGNMENT")
            require(aid not in responses, "DUPLICATE_RESPONSE")
            case = cases[assignments[aid]["caseId"]]
            require(response["status"] in ("COMPLETE", "ABSTAIN", "TECHNICAL_FAILURE", "TIMEOUT"), "INVALID_RESPONSE_STATUS")
            number(response["elapsedSeconds"], 0, limit)
            if response["status"] == "COMPLETE":
                require(response["value"] in (EVENT_VALUES if case["feature"] == "F03" else MATRIX_VALUES), "INVALID_RESPONSE_VALUE")
                require(type(response["contradiction"]) is bool, "CONTRADICTION_REQUIRED")
                number(response["confidencePercent"], 0, 100)
                window = response["window"]
                if window is not None:
                    keys(window, ["slot", "startMs", "endMs"])
                    valid_slots = {f"source-{i+1}": asset for i, asset in enumerate(case["originals"])}
                    require(window["slot"] in valid_slots, "RESPONSE_SOURCE_MISMATCH")
                    number(window["startMs"], 0, valid_slots[window["slot"]]["durationMs"])
                    number(window["endMs"], window["startMs"], valid_slots[window["slot"]]["durationMs"])
            else:
                require(all(response[field] is None for field in ("value", "contradiction", "window", "confidencePercent")), "INCOMPLETE_RESPONSE_MUST_NOT_ASSERT_FINDING")
            responses[aid] = response
    rows = []
    for aid, assignment in assignments.items():
        case = cases[assignment["caseId"]]
        r = responses.get(aid)
        scorable = case["reference"]["state"] == "RESOLVED"
        answered = r is not None and r["status"] == "COMPLETE"
        correct = response_correct(case, r, plan["manifest"]["policy"]["eventToleranceMs"]) if answered and scorable else None
        rows.append({**assignment, "feature": case["feature"], "stratum": case["stratum"],
                     "referenceScorable": scorable, "status": r["status"] if r else "NO_RESPONSE",
                     "correct": correct, "elapsedSeconds": r["elapsedSeconds"] if r else None,
                     "confidence": r["confidencePercent"] / 100 if answered else None,
                     "contradictionReference": case["reference"]["contradiction"] if scorable else None,
                     "contradictionResponse": r["contradiction"] if answered else None,
                     "value": r["value"] if answered else None,
                     "referenceValue": case["reference"]["value"] if scorable else None})
    report = {"schemaVersion": SCHEMA, "manifestDigest": plan["manifestDigest"],
              "submissionDigests": sorted(digest(s) for s in submissions), "dataOrigin": plan["manifest"]["dataOrigin"],
              "assignedReviewers": len(plan["packets"]), "assignedCases": len({r["caseId"] for r in rows}),
              "qualified": False, "releaseAuthorized": False, "groups": [], "caseContrasts": []}
    for feature in sorted({r["feature"] for r in rows}):
        for condition in ("ORIGINAL_ONLY", "ENRICHED"):
            for stratum in [None] + sorted({r["stratum"] for r in rows if r["feature"] == feature}):
                subset = [r for r in rows if r["feature"] == feature and r["condition"] == condition and (stratum is None or r["stratum"] == stratum)]
                report["groups"].append({"feature": feature, "condition": condition, "stratum": stratum,
                                          **summarize(subset, limit)})
    # Case-level contrasts retain specimen clustering; no pseudo-independent p-value.
    for cid in sorted({r["caseId"] for r in rows}):
        case_rows = [r for r in rows if r["caseId"] == cid]
        metrics = {c: summarize([r for r in case_rows if r["condition"] == c], limit) for c in ("ORIGINAL_ONLY", "ENRICHED")}
        base, enriched = metrics.values()
        report["caseContrasts"].append({"caseToken": token(plan["manifest"]["policy"]["seed"], cid),
            "feature": case_rows[0]["feature"], "referenceScorable": case_rows[0]["referenceScorable"],
            "assignedPerCondition": base["assigned"], "enrichedMinusOriginalCorrectPerAssigned": enriched["correctPerAssigned"] - base["correctPerAssigned"]})
    report["limitations"] = ["Descriptive observations only; no pass threshold, causal significance or qualification is calculated.",
        "Reviewers and cases are crossed repeated factors. Do not treat assignments as independent specimens; obtain a prespecified crossed-effects analysis for confirmatory inference.",
        "All assigned tasks remain in denominators. Disputed references are separately counted, not silently marked correct or incorrect.",
        "Browser timing is an unauthenticated local observation; interruption, accommodation and protocol deviations require a separate private log.",
        "Blinding hides coordinator labels and outcomes; reviewers can perceive enrichment. Asset bytes may contain identities and need a separate privacy/blinding audit.",
        "Data origin, consent, annotation independence and the pre-review freeze are coordinator declarations; the toolkit cannot verify those human facts.",
        "Reference agreement measures an observational task, not fraud, authenticity, custody, responsibility or claim disposition."]
    # Agreement is calculated only among reviewers of the same case AND condition.
    # Unanswered assignments stay in the possible-pair denominator.
    pair_groups = defaultdict(list)
    for row in rows:
        pair_groups[(row["feature"], row["condition"], row["caseId"])].append(row)
    agreement = defaultdict(Counter)
    for (feature, condition, _), group in pair_groups.items():
        metrics = agreement[(feature, condition)]
        for i, left in enumerate(group):
            for right in group[i+1:]:
                metrics["assignedPairs"] += 1
                if left["status"] == right["status"] == "COMPLETE":
                    metrics["answeredPairs"] += 1
                    metrics["sameObservationAndConflict"] += (left["value"], left["contradictionResponse"]) == (right["value"], right["contradictionResponse"])
    report["reviewerAgreement"] = [{"feature": key[0], "condition": key[1],
        **{name: values[name] for name in ("assignedPairs", "answeredPairs", "sameObservationAndConflict")},
        "scope": "Descriptive categorical pair agreement; event interval overlap is not included. Pairs are dependent."}
        for key, values in sorted(agreement.items())]
    return report


def summarize(rows, limit):
    statuses = Counter(r["status"] for r in rows)
    resolved = [r for r in rows if r["referenceScorable"]]
    answered = [r for r in resolved if r["status"] == "COMPLETE"]
    correct = sum(r["correct"] is True for r in rows)
    contradictions = [r for r in resolved if r["contradictionReference"]]
    no_contradictions = [r for r in resolved if not r["contradictionReference"]]
    successful_times = [r["elapsedSeconds"] for r in rows if r["correct"] is True]
    bins = []
    for low in range(0, 100, 20):
        selected = [r for r in answered if low / 100 <= r["confidence"] and (r["confidence"] < (low + 20) / 100 or low == 80)]
        bins.append({"confidenceRange": [low, low + 20], "n": len(selected),
                     "meanConfidence": statistics.mean(r["confidence"] for r in selected) if selected else None,
                     "referenceAgreement": sum(r["correct"] for r in selected) / len(selected) if selected else None})
    return {"assigned": len(rows), "referenceScorableAssigned": len(resolved), "referenceDisputedAssigned": len(rows) - len(resolved),
            "statuses": {name: statuses[name] for name in ("COMPLETE", "ABSTAIN", "TECHNICAL_FAILURE", "TIMEOUT", "NO_RESPONSE")},
            "correct": correct, "incorrectAnswered": sum(r["correct"] is False for r in rows),
            "correctPerAssigned": correct / len(rows),
            "correctPerScorableAssigned": correct / len(resolved) if resolved else None,
            "answeredScorable": len(answered),
            "contradictionEligibleAssigned": len(contradictions),
            "contradictionsDetected": sum(r["contradictionResponse"] is True for r in contradictions),
            "contradictionNotDetectedOrUnanswered": sum(r["contradictionResponse"] is not True for r in contradictions),
            "noContradictionEligibleAssigned": len(no_contradictions),
            "falseContradictionReports": sum(r["contradictionResponse"] is True for r in no_contradictions),
            "missingValueEligibleAssigned": sum(r["referenceValue"] in ("MISSING_VALUE", "NOT_ASSESSABLE") for r in resolved),
            "missingValueCorrect": sum(r["correct"] is True and r["referenceValue"] in ("MISSING_VALUE", "NOT_ASSESSABLE") for r in resolved),
            "medianSecondsCorrectOnly": statistics.median(successful_times) if successful_times else None,
            "failurePenalizedSecondsPerScorableAssigned": statistics.mean(r["elapsedSeconds"] if r["correct"] is True else limit for r in resolved) if resolved else None,
            "penaltySeconds": limit, "brierAnsweredScorable": statistics.mean((r["confidence"] - int(r["correct"]))**2 for r in answered) if answered else None,
            "calibrationBinsAnsweredScorable": bins}


def render_html(packet):
    data = json.dumps(packet, separators=(",", ":")).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    template = Path(__file__).with_name("reviewer.html").read_text(encoding="utf-8")
    return template.replace("/*PACKET_DATA*/", data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prep = sub.add_parser("prepare")
    prep.add_argument("--manifest", required=True); prep.add_argument("--assets", required=True)
    prep.add_argument("--output", required=True); prep.add_argument("--max-output-bytes", type=int, default=2 * 1024**3)
    scoring = sub.add_parser("score")
    scoring.add_argument("--key", required=True); scoring.add_argument("--responses", nargs="*", default=[])
    scoring.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(load(args.manifest), args.assets, args.output, args.max_output_bytes)
    else:
        write(args.output, score(load(args.key), [load(p) for p in args.responses]))
    print(json.dumps({"state": "WRITTEN", "qualified": False, "releaseAuthorized": False}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        # Do not echo local paths or submitted content into shared logs.
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]+", str(error)) else "INVALID_INPUT_OR_LOCAL_FILE"
        print(json.dumps({"state": "REJECTED", "reason": code, "qualified": False}), file=sys.stderr)
        raise SystemExit(2)
