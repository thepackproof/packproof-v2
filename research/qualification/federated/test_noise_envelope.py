import copy
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from noise_envelope import evaluate


class NoisePlanningTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads(Path(__file__).with_name("example-assumptions.json").read_text())

    def test_dropout_and_known_noise_counterexample(self):
        report = evaluate(self.config)
        worst = report["cases"][4]  # 20 survivors, four known noise contributors.
        self.assertEqual(worst["hypothesizedHonestSurvivors"], 16)
        self.assertEqual(report["perHonestParticipantIdealNoiseStd"], 2)
        self.assertAlmostEqual(worst["plannedIdealMeanNoiseStd"], .4)
        self.assertAlmostEqual(worst["plannedIdealEffectiveMultiplier"], 4)
        self.assertAlmostEqual(worst["nominalCohortEffectiveMultiplier"], 4 * math.sqrt(16 / 24))
        self.assertTrue(worst["nominalCohortVarianceShortfall"])
        self.assertFalse(report["qualified"])
        self.assertIsNone(report["epsilonClaim"])

    def test_all_admitted_survivor_cases_retain_planned_variance(self):
        report = evaluate(self.config)
        self.assertEqual(len(report["cases"]), 25)
        for case in report["cases"]:
            self.assertGreaterEqual(case["plannedIdealEffectiveMultiplier"] + 1e-12, 4)
        self.config.update(minimumSurvivors=24, maximumColludingSurvivors=0)
        only = evaluate(self.config)["cases"][0]
        self.assertAlmostEqual(only["nominalCohortEffectiveMultiplier"], 4)
        self.assertFalse(only["nominalCohortVarianceShortfall"])

    def test_rejects_invalid_or_ambiguous_assumptions(self):
        for field, value in [("minimumSurvivors", 19), ("minimumSurvivors", 25),
                             ("maximumColludingSurvivors", 20), ("enrolledContributors", True),
                             ("enrolledContributors", 65), ("clipL2", float("nan")),
                             ("targetNoiseMultiplier", float("inf")), ("clipL2", 0)]:
            config = copy.deepcopy(self.config)
            config[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                evaluate(config)
        self.config["approved"] = True
        with self.assertRaises(ValueError):
            evaluate(self.config)

    def test_numeric_extremes_fail_without_underflow_or_overflow(self):
        for changes in ({"clipL2": 5e-324}, {"targetNoiseMultiplier": 5e-324},
                        {"clipL2": 10**400}, {"clipL2": 1e-200, "targetNoiseMultiplier": 1e-200}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                evaluate({**self.config, **changes})

    def cli(self, directory, encoded):
        source = directory / "input.json"
        source.write_bytes(encoded)
        return subprocess.run([sys.executable, str(Path(__file__).with_name("noise_envelope.py")),
                               "--config", str(source), "--output", str(directory / "result.json")],
                              capture_output=True, text=True, timeout=10)

    def test_cli_rejects_duplicate_and_oversized_inputs_without_output(self):
        valid = json.dumps(self.config).encode()
        for encoded in (valid[:-1] + b', "maximumColludingSurvivors": 0}', b' ' * 16385):
            with tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                self.assertNotEqual(self.cli(directory, encoded).returncode, 0)
                self.assertFalse((directory / "result.json").exists())

    def test_cli_binds_input_and_preserves_existing_output(self):
        import hashlib
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            encoded = json.dumps(self.config).encode()
            self.assertEqual(self.cli(directory, encoded).returncode, 0)
            output = directory / "result.json"
            original = output.read_bytes()
            self.assertEqual(json.loads(original)["configSha256"], hashlib.sha256(encoded).hexdigest())
            self.assertNotEqual(self.cli(directory, encoded).returncode, 0)
            self.assertEqual(output.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
