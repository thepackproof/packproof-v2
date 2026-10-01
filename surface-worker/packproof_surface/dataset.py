"""Split validation, frozen/blinded scoring, and separate ground-truth reporting.

No sample imagery or invented physical performance is shipped. Synthetic entries can
exercise this harness but are flagged and cannot satisfy physical qualification.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from .contracts import InputError, canonical, digest, read_json, media_bytes
from .engine import load_profile, method_metadata, run, initialize

VARIANTS = ("barcode_only", "image_layout_only", "print_residual", "substrate_only", "relationship_only", "single_frame", "multi_frame", "complete_system")
IDENTITIES = ("physicalPrintId", "labelSubstrateId", "cartonId")
METADATA = ("designId", "printerUnitId", "mediaLotId", "captureSessionId", "operatorId", "deviceFamily")
SPLITS = {"development", "validation", "blind", "domain_holdout", "golden"}

def validate_manifest(manifest, media_root=None):
    errors, warnings = [], []
    if manifest.get("schemaVersion") != "surface-dataset/1":
        return {"valid": False, "errors": ["Unsupported dataset schema"], "warnings": []}
    captures, pairs = manifest.get("captures", []), manifest.get("pairs", [])
    if not isinstance(captures, list) or not isinstance(pairs, list):
        return {"valid": False, "errors": ["captures and pairs must be lists"], "warnings": []}
    ids, by_id = set(), {}
    split_entities = defaultdict(lambda: defaultdict(set))
    counts = Counter()
    required_holdouts = set(manifest.get("splitPolicy", {}).get("disjointDomains", []))
    if not required_holdouts.issubset(set(METADATA)):
        errors.append("Unknown disjoint domain in split policy")
    profile = load_profile("research-paper-v1")
    for capture in captures:
        cid = capture.get("id")
        if not isinstance(cid, str) or not cid or cid in ids:
            errors.append("Missing or duplicate capture id")
            continue
        ids.add(cid)
        by_id[cid] = capture
        split = capture.get("split")
        if split not in SPLITS:
            errors.append(f"{cid}: invalid split")
        if not isinstance(capture.get("synthetic"), bool):
            errors.append(f"{cid}: synthetic flag is required")
        if capture.get("acquisitionMode") not in {"passive_video", "concurrent_frame", "coached_closeup", "supplemental"}:
            errors.append(f"{cid}: acquisition mode required")
        if capture.get("printProcess") not in {"inkjet", "laser", "thermal_transfer", "direct_thermal", "substrate"}:
            errors.append(f"{cid}: print process required")
        counts[(split, capture.get("synthetic"))] += 1
        for key in IDENTITIES + METADATA + ("assemblyId", "shipmentLegId", "nominalContentId"):
            value = capture.get(key)
            if not isinstance(value, str) or not value:
                errors.append(f"{cid}: missing {key}")
            elif key in IDENTITIES or key in required_holdouts:
                split_entities[key][value].add(split)
        try:
            from .contracts import validate_capture
            validate_capture(capture.get("capture"), profile, cid)
            for source in capture["capture"]["sources"]:
                split_entities["sourceSha256"][source["sha256"]].add(split)
            if media_root is not None:
                for source in capture["capture"]["sources"]:
                    media_bytes(media_root, source, profile["engineeringBounds"])
        except (InputError, OSError, KeyError, TypeError) as exc:
            errors.append(f"{cid}: {exc}")
    for key, values in split_entities.items():
        for value, splits in values.items():
            if len(splits) > 1:
                errors.append(f"Split leakage: {key}={value} appears in {','.join(sorted(str(v) for v in splits))}")
    seen_pairs = set()
    same_content = 0
    for pair in pairs:
        pid = pair.get("id")
        if not isinstance(pid, str) or not pid or pid in seen_pairs:
            errors.append("Missing or duplicate pair id")
            continue
        seen_pairs.add(pid)
        left, right = by_id.get(pair.get("enrollmentId")), by_id.get(pair.get("observationId"))
        if not left or not right:
            errors.append(f"{pid}: unknown capture")
            continue
        if left["id"] == right["id"]:
            errors.append(f"{pid}: self-pair is not an independent capture")
        if left.get("split") != right.get("split") or pair.get("split") != left.get("split"):
            errors.append(f"{pid}: pair crosses split boundary")
        if left.get("nominalContentId") == right.get("nominalContentId") and left.get("physicalPrintId") != right.get("physicalPrintId"):
            same_content += 1
    if not captures:
        warnings.append("Corpus is empty: no physical samples or optical validation exist.")
    elif same_content == 0:
        errors.append("Same-content distinct physical-print pairs are mandatory.")
    if any(c.get("synthetic") for c in captures):
        warnings.append("Synthetic entries test plumbing only and cannot establish physical performance.")
    if not required_holdouts:
        warnings.append("No domain holdouts declared; design, printer, lot, session, operator, device-family generalization unestablished.")
    return {"valid": not errors, "errors": errors, "warnings": warnings, "manifestSha256": digest(manifest),
            "captureCount": len(captures), "pairCount": len(pairs), "sameContentDifferentPrintPairs": same_content,
            "physicalCaptureCount": sum(c.get("synthetic") is False for c in captures),
            "counts": [{"split": k[0], "synthetic": k[1], "captures": v} for k, v in sorted(counts.items(), key=str)],
            "qualification": "unqualified"}

def freeze_manifest(manifest, thresholds=None):
    valid = validate_manifest(manifest)
    if not valid["valid"]:
        raise InputError("Invalid dataset: " + "; ".join(valid["errors"][:5]))
    initialize()
    thresholds = thresholds or {v: None for v in VARIANTS}
    if set(thresholds) != set(VARIANTS):
        raise InputError("Provide thresholds or null for every ablation")
    for variant, threshold in thresholds.items():
        if threshold is not None:
            if not isinstance(threshold, dict) or set(threshold) != {"differenceAtOrBelow", "consistentAtOrAbove"}:
                raise InputError("Threshold requires explicit differenceAtOrBelow and consistentAtOrAbove")
            a, b = threshold["differenceAtOrBelow"], threshold["consistentAtOrAbove"]
            if not isinstance(a, (int, float)) or not isinstance(b, (int, float)) or not -1 <= a < b <= 1:
                raise InputError("Invalid research thresholds")
    frozen = {"schemaVersion": "surface-evaluation-freeze/1", "datasetSha256": digest(manifest),
              "method": method_metadata(load_profile("research-paper-v1")), "thresholds": thresholds,
              "purpose": "Blinded R&D evaluation only; thresholds cannot enable application findings.",
              "productionEligible": False}
    frozen["artifactSha256"] = digest(frozen)
    return frozen

def research_scores(result, left, right):
    by_group = defaultdict(list)
    layout, first = [], []
    for region in result["regionResults"]:
        value = region.get("researchResidualMedian")
        if value is not None:
            by_group[region["group"]].append(value)
        for observation in region["observations"]:
            if observation.get("layoutCorrelation") is not None:
                layout.append(observation["layoutCorrelation"])
        usable = [o["residualCorrelation"] for o in region["observations"] if o.get("residualCorrelation") is not None and "reason" not in o]
        if usable:
            first.append(usable[0])
    def minimum(values):
        return round(min(values), 6) if values else None
    complete = all(v["completeForResearch"] for v in result["coverage"].values())
    all_residuals = by_group["print"] + by_group["carton"]
    # Relationship baseline uses normalized region-center placement only, no physical finding.
    relations = []
    left_regions = {r.get("trackId") or r["id"]: r for r in left["capture"]["regions"]}
    right_regions = {r.get("trackId") or r["id"]: r for r in right["capture"]["regions"]}
    for key in set(left_regions) & set(right_regions):
        a, b = left_regions[key], right_regions[key]
        ca = [sum(p[i] for p in a["polygon"]) / 4 for i in range(2)]
        cb = [sum(p[i] for p in b["polygon"]) / 4 for i in range(2)]
        da = math.dist(a["polygon"][0], a["polygon"][2])
        db = math.dist(b["polygon"][0], b["polygon"][2])
        if da and db:
            relations.append(max(-1.0, 1 - math.dist([v / da for v in ca], [v / db for v in cb])))
    return {"barcode_only": (1.0 if left.get("nominalContentId") == right.get("nominalContentId") else -1.0),
            "image_layout_only": minimum(layout), "print_residual": minimum(by_group["print"]),
            "substrate_only": minimum(by_group["carton"]), "relationship_only": minimum(relations),
            "single_frame": minimum(first), "multi_frame": minimum(all_residuals),
            "complete_system": minimum(all_residuals) if complete else None}

def score_blind(manifest, frozen, media_root, split):
    report = validate_manifest(manifest, media_root)
    if not report["valid"]:
        raise InputError("Invalid dataset: " + "; ".join(report["errors"][:5]))
    expected = freeze_manifest(manifest, frozen.get("thresholds"))
    if frozen != expected:
        raise InputError("Dataset, runtime, source artifacts, or thresholds differ from the frozen evaluation")
    lookup = {c["id"]: c for c in manifest["captures"]}
    predictions = []
    for pair in manifest["pairs"]:
        if pair["split"] != split:
            continue
        left, right = lookup[pair["enrollmentId"]], lookup[pair["observationId"]]
        job = {"schemaVersion": "surface-job/1", "jobId": pair["id"], "operation": "compare", "profileId": "research-paper-v1",
               "enrollment": left["capture"], "observation": right["capture"], "requestedScope": "assembly"}
        result = run(job, media_root)
        scores = research_scores(result, left, right)
        decisions = {}
        for variant, value in scores.items():
            threshold = frozen["thresholds"][variant]
            decisions[variant] = ("inconclusive" if value is None or threshold is None else
                                  "consistent" if value >= threshold["consistentAtOrAbove"] else
                                  "difference_observed" if value <= threshold["differenceAtOrBelow"] else "inconclusive")
        predictions.append({"pairId": pair["id"], "synthetic": left["synthetic"] or right["synthetic"],
                            "scores": scores, "researchDecisions": decisions, "applicationStatus": result["status"],
                            "resultSha256": result["artifactSha256"],
                            "physicalUnitIds": sorted({key+":"+capture[key] for capture in (left,right) for key in IDENTITIES}), "devicePair": left["deviceFamily"] + "->" + right["deviceFamily"],
                            "process": left["printProcess"], "acquisitionMode": left["acquisitionMode"] + "->" + right["acquisitionMode"]})
    output = {"schemaVersion": "surface-predictions/1", "datasetSha256": digest(manifest), "freezeSha256": frozen["artifactSha256"],
              "split": split, "predictions": predictions, "productionEligible": False,
              "blinding": "Scoring consumes no truth file. Independent custodian must seal identities and keep truth inaccessible during scoring."}
    output["artifactSha256"] = digest(output)
    return output

def wilson(successes, total):
    if total == 0:
        return None
    z = 1.959963984540054
    p, den = successes / total, 1 + z * z / total
    center = (p + z * z / (2 * total)) / den
    width = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / den
    return [round(max(0.0, center - width), 8), round(min(1.0, center + width), 8)]

def metric_table(rows, variant, scope):
    positive, negative, genuine, false_consistent, false_difference, conclusive = 0, 0, 0, 0, 0, 0
    for prediction, truth in rows:
        actual = truth[scope + "Same"]
        decision = prediction["researchDecisions"][variant]
        positive += actual
        negative += not actual
        conclusive += decision != "inconclusive"
        false_consistent += not actual and decision == "consistent"
        false_difference += actual and decision == "difference_observed"
        genuine += actual and decision == "consistent"
    count = len(rows)
    conclusive_negatives = sum(not t[scope + "Same"] and p["researchDecisions"][variant] != "inconclusive" for p,t in rows)
    conclusive_positives = sum(t[scope + "Same"] and p["researchDecisions"][variant] != "inconclusive" for p,t in rows)
    def rate(n, d):
        return {"numerator": int(n), "denominator": int(d), "rate": n / d if d else None,
                "descriptiveWilson95": wilson(n, d), "intervalCaveat": "Bernoulli interval is descriptive only where trials reuse physical units."}
    independent_rows = [(p, t) for p, t in rows if not t[scope + "Same"] and t.get("independentTrial") is True]
    units = [t.get("independenceUnit") for _, t in independent_rows]
    physical_units = [unit for p, _ in independent_rows for unit in p.get("physicalUnitIds", [])]
    independent = (len(independent_rows) == negative and len(set(units)) == negative and all(units)
                   and all(t.get("independenceReviewed") is True and p.get("physicalUnitIds") for p, t in independent_rows)
                   and len(set(physical_units)) == len(physical_units))
    upper = (1 - 0.05 ** (1 / negative)) if independent and negative and false_consistent == 0 else None
    return {"trials": count, "conclusiveCoverage": rate(conclusive, count),
            "falseConsistencyWholeFlow": rate(false_consistent, negative),
            "genuineDifferenceWholeFlow": rate(false_difference, positive),
            "falseConsistencyAmongConclusive": rate(false_consistent, conclusive_negatives),
            "genuineDifferenceAmongConclusive": rate(false_difference, conclusive_positives),
            "endToEndGenuineSuccess": rate(genuine, positive), "abstention": rate(count - conclusive, count),
            "falseConsistencyOneSided95ZeroErrorUpper": upper,
            "independence": "Custodian-attested unique independent trials" if independent else "Not established; no rare-error confidence claim",
            "rareErrorTargetEstablished": bool(upper is not None and upper <= 0.0001 and count == conclusive)}

def risk_curve(rows, variant, scope):
    # Prespecified diagnostic sweep; do not retune and reuse this blind test set.
    if not rows:
        return []
    points = []
    for step in range(-9, 10):
        threshold = step / 10
        conclusive = errors = 0
        for prediction, truth in rows:
            score = prediction["scores"].get(variant)
            if score is None or threshold - 0.1 < score < threshold + 0.1:
                continue
            conclusive += 1
            positive = score >= threshold + 0.1
            errors += positive != truth[scope + "Same"]
        points.append({"centerThreshold": threshold, "abstentionHalfWidth": 0.1,
                       "coverage": conclusive / len(rows), "errorsAmongConclusive": errors / conclusive if conclusive else None,
                       "conclusive": conclusive, "total": len(rows)})
    return points

def evaluate(predictions, truth):
    if predictions.get("schemaVersion") != "surface-predictions/1" or truth.get("schemaVersion") != "surface-truth/1":
        raise InputError("Unknown evaluation schema")
    if digest({k: v for k, v in predictions.items() if k != "artifactSha256"}) != predictions.get("artifactSha256"):
        raise InputError("Prediction artifact digest mismatch")
    if truth.get("datasetSha256") != predictions.get("datasetSha256"):
        raise InputError("Truth belongs to a different dataset")
    if truth.get("predictionsSha256") != predictions.get("artifactSha256"):
        raise InputError("Custodian must bind truth to completed prediction artifact before unblinding")
    lookup = {}
    for row in truth.get("pairs", []):
        if row.get("pairId") in lookup:
            raise InputError("Duplicate ground-truth pair")
        if any(not isinstance(row.get(scope + "Same"), bool) for scope in ("label", "carton", "assembly")):
            raise InputError("Ground truth must distinguish label, carton, and assembly")
        lookup[row["pairId"]] = dict(row, independenceReviewed=truth.get("independenceReviewed") is True)
    rows = []
    for prediction in predictions.get("predictions", []):
        if prediction["pairId"] not in lookup:
            raise InputError("Missing ground truth; exclusions cannot disappear silently")
        rows.append((prediction, lookup[prediction["pairId"]]))
    physical = [(p, t) for p, t in rows if not p["synthetic"]]
    synthetic = [(p, t) for p, t in rows if p["synthetic"]]
    by_variant = {variant: {scope: metric_table(physical, variant, scope) for scope in ("label", "carton", "assembly")} for variant in VARIANTS}
    strata = {}
    for key in ("devicePair", "process", "acquisitionMode", "attackFamily"):
        groups = defaultdict(list)
        for p, t in physical:
            groups[t.get(key, p.get(key, "unknown"))].append((p, t))
        strata[key] = {str(value): metric_table(group, "complete_system", "assembly") for value, group in groups.items()}
    return {"schemaVersion": "surface-evaluation-report/1", "datasetSha256": predictions["datasetSha256"],
            "freezeSha256": predictions["freezeSha256"], "predictionSha256": predictions["artifactSha256"],
            "truthSha256": digest(truth), "physicalTrials": len(physical), "syntheticPlumbingTrials": len(synthetic),
            "metrics": by_variant, "strata": strata,
            "riskCoverageDiagnostics": {v: risk_curve(physical, v, "assembly") for v in VARIANTS}, "qualification": "unqualified", "productionEligible": False,
            "limitations": ["No report automatically qualifies a profile or enables application findings.",
                            "Metrics require independent review of sampling, identity leakage, correlated captures, and frozen thresholds.",
                            "Passive enrollment success, capture interruption, aging, latency, and cost require separate measured logs.",
                            "Zero failures with all abstentions do not establish low false acceptance."]}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    validate = sub.add_parser("validate")
    validate.add_argument("--manifest", required=True)
    validate.add_argument("--media-root")
    freeze = sub.add_parser("freeze")
    freeze.add_argument("--manifest", required=True)
    freeze.add_argument("--thresholds")
    freeze.add_argument("--output", required=True)
    score = sub.add_parser("score")
    score.add_argument("--manifest", required=True)
    score.add_argument("--freeze", required=True)
    score.add_argument("--media-root", required=True)
    score.add_argument("--split", choices=sorted(SPLITS), default="blind")
    score.add_argument("--output", required=True)
    report = sub.add_parser("report")
    report.add_argument("--predictions", required=True)
    report.add_argument("--truth", required=True)
    report.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        if args.command == "validate":
            result = validate_manifest(read_json(args.manifest), args.media_root)
        elif args.command == "freeze":
            result = freeze_manifest(read_json(args.manifest), read_json(args.thresholds) if args.thresholds else None)
        elif args.command == "score":
            result = score_blind(read_json(args.manifest), read_json(args.freeze), args.media_root, args.split)
        else:
            result = evaluate(read_json(args.predictions), read_json(args.truth))
        encoded = canonical(result) + b"\n"
        if getattr(args, "output", None):
            with open(args.output, "xb") as f:
                f.write(encoded)
        else:
            print(encoded.decode(), end="")
        return 0 if result.get("valid", True) else 2
    except (InputError, OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"status": "error", "message": str(exc)[:400]}))
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
