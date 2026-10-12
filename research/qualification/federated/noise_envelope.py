"""Offline Gaussian variance planning; never trains, samples noise or enables a mode.

This necessary variance calculation is not a distributed DP implementation or proof.
Discrete noise, quantization, malicious clients and transcript privacy need review.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

SCHEMA = "packproof.distributed-noise-planning.v1"
FIELDS = {"schemaVersion", "enrolledContributors", "minimumSurvivors",
          "maximumColludingSurvivors", "clipL2", "targetNoiseMultiplier"}


def _integer(value, name, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer in {minimum}..{maximum}")
    return value


def _positive(value, name):
    if type(value) not in (int, float) or not 0 < value <= 100 or not math.isfinite(value):
        raise ValueError(f"{name} must be finite and in (0, 100]")
    return float(value)


def _representable(*values):
    if any(not math.isfinite(value) or value < sys.float_info.min for value in values):
        raise ValueError("Derived values must be positive normal finite floats; assumptions underflow")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate planning field: {key}")
        result[key] = value
    return result


def evaluate(config):
    if type(config) is not dict or set(config) != FIELDS or config.get("schemaVersion") != SCHEMA:
        raise ValueError("Unknown planning schema or fields")
    count = _integer(config["enrolledContributors"], "enrolledContributors", 20, 64)
    floor = _integer(config["minimumSurvivors"], "minimumSurvivors", 20, count)
    colluders = _integer(config["maximumColludingSurvivors"], "maximumColludingSurvivors", 0, floor - 1)
    clip = _positive(config["clipL2"], "clipL2")
    multiplier = _positive(config["targetNoiseMultiplier"], "targetNoiseMultiplier")
    honest_floor = floor - colluders
    # Replacement sensitivity of the SUM of vectors clipped to L2 C is 2C.
    # Noise of known/colluding survivors contributes no hidden variance.
    target_sum_std = multiplier * 2 * clip
    share_std = target_sum_std / math.sqrt(honest_floor)
    nominal_share_std = target_sum_std / math.sqrt(count)
    _representable(target_sum_std, share_std, nominal_share_std)
    rows = []
    for survivors in range(floor, count + 1):
        for known in range(colluders + 1):
            honest = survivors - known
            sensitivity = 2 * clip / survivors
            actual_std = math.sqrt(honest) * share_std / survivors
            naive_std = math.sqrt(honest) * nominal_share_std / survivors
            _representable(sensitivity, actual_std, naive_std, multiplier * sensitivity)
            _representable(actual_std / sensitivity, naive_std / sensitivity)
            rows.append({
                "survivors": survivors, "colludingSurvivors": known,
                "hypothesizedHonestSurvivors": honest,
                "replacementSensitivityOfMean": sensitivity,
                "requiredMeanNoiseStd": multiplier * sensitivity,
                "plannedIdealMeanNoiseStd": actual_std,
                "plannedIdealEffectiveMultiplier": actual_std / sensitivity,
                "nominalCohortEffectiveMultiplier": naive_std / sensitivity,
                "nominalCohortVarianceShortfall": honest < count,
            })
    return {
        "schemaVersion": "packproof.distributed-noise-envelope.v1",
        "scope": "IDEAL_CONTINUOUS_GAUSSIAN_VARIANCE_PLANNING_ONLY",
        "assumptions": config, "minimumHypothesizedHonestSurvivors": honest_floor,
        "replacementSensitivityOfSum": 2 * clip,
        "requiredHiddenSumNoiseStd": target_sum_std,
        "perHonestParticipantIdealNoiseStd": share_std,
        "nominalCohortOnlyNoiseStd": nominal_share_std,
        "cases": rows, "noiseSampled": False, "trainingExecuted": False,
        "independentOrganizationsVerified": 0, "epsilonClaim": None,
        "mechanismImplemented": False, "qualified": False,
        "distributedModeEnabled": False, "releaseAuthorized": False,
        "limitations": [
            "Independent zero-mean noise and a fixed survivor roster are assumed, not verified.",
            "Known colluder noise is conservatively removed from hidden variance.",
            "Variance sufficiency alone is not a differential privacy proof.",
            "Discrete sampling, rounding, modular wraparound and finite precision are unmodeled.",
            "No malicious clipping, Sybil resistance, adaptive dropout or transcript guarantee.",
            "No multi-round accountant, amplification, utility or deployment claim.",
        ],
    }


def flower_probe():
    """Inspect the installed library using only public, deterministic test numbers."""
    import importlib.metadata
    import inspect
    import numpy as np
    from flwr.common.secure_aggregation.quantization import quantize, dequantize
    values = np.array([-4.0, -1.0, 0.0, 1.0, 4.0])
    decoded = dequantize(quantize([values], 1.0, 2**22), 1.0, 2**22)[0]
    if not np.array_equal(decoded, np.array([-1., -1., 0., 1., 1.])):
        raise ValueError("Installed quantizer behavior differs; review the integration")
    source = Path(inspect.getfile(quantize)).read_bytes()
    return {"flowerVersion": importlib.metadata.version("flwr"),
            "quantizerSourceSha256": hashlib.sha256(source).hexdigest(),
            "publicInputs": values.tolist(), "decoded": decoded.tolist(),
            "observation": "The current encoder clips before quantization. Adding unbounded noise before it does not preserve the intended additive Gaussian mechanism.",
            "privacyConclusion": "No privacy guarantee inferred from this diagnostic."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--probe-installed-flower", action="store_true")
    args = parser.parse_args()
    with args.config.open("rb") as stream:
        encoded = stream.read(16385)
    if len(encoded) > 16384:
        raise ValueError("Planning configuration exceeds 16 KiB")
    report = evaluate(json.loads(encoded, object_pairs_hook=_unique_object))
    report["configSha256"] = hashlib.sha256(encoded).hexdigest()
    report["toolSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    if args.probe_installed_flower:
        report["installedQuantizerProbe"] = flower_probe()
    # Never overwrite an earlier assessment or input file.
    with args.output.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(report, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps({"cases": len(report["cases"]), "qualified": False,
                      "distributedModeEnabled": False, "output": str(args.output)}))


if __name__ == "__main__":
    main()
