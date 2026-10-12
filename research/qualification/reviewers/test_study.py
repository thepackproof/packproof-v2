import copy
from collections import Counter
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from research.qualification.reviewers import study
from research.qualification.reviewers.synthetic_demo import create


class ReviewerStudyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.assets = self.root / "private"
        self.manifest = create(self.assets)
        self.plan = study.make_plan(self.manifest)

    def response(self, assignment, **changes):
        case = next(c for c in self.manifest["cases"] if c["caseId"] == assignment["caseId"])
        value = case["reference"]["value"]
        row = {"assignmentId": assignment["assignmentId"], "status": "COMPLETE", "elapsedSeconds": 8,
               "value": value, "contradiction": False, "confidencePercent": 80,
               "window": {"slot": "source-1", "startMs": 1000, "endMs": 2000} if case["feature"] == "F03" else None}
        row.update(changes)
        return row

    def submission(self, assignments, rows=None):
        return {"schemaVersion": study.SCHEMA, "manifestDigest": self.plan["manifestDigest"],
                "reviewerToken": assignments[0]["reviewerToken"],
                "responses": rows if rows is not None else [self.response(a) for a in assignments]}

    def all_submissions(self):
        return [self.submission([a for a in self.plan["assignments"] if a["reviewerToken"] == reviewer]) for reviewer in self.plan["packets"]]

    def test_deterministic_counterbalance_per_case_reviewer_and_stratum(self):
        self.assertEqual(self.plan, study.make_plan(self.manifest))
        for case in self.manifest["cases"]:
            self.assertEqual(Counter(a["condition"] for a in self.plan["assignments"] if a["caseId"] == case["caseId"]), {"ORIGINAL_ONLY": 2, "ENRICHED": 2})
        for reviewer in self.plan["packets"]:
            for feature in ("F03", "F05"):
                own = [a for a in self.plan["assignments"] if a["reviewerToken"] == reviewer and feature in a["caseId"]]
                self.assertEqual(Counter(a["condition"] for a in own), {"ORIGINAL_ONLY": 1, "ENRICHED": 1})
            self.assertEqual(len({t["assignmentId"] for t in self.plan["packets"][reviewer]}), 4)

    def test_reviewer_packets_hide_coordinator_labels_and_original_paths(self):
        self.manifest["cases"][0]["originals"][0]["slot"] = "private-customer-slot"
        self.manifest["cases"][0]["reference"]["acceptableWindows"][0]["slot"] = "private-customer-slot"
        output = self.root / "prepared"
        study.prepare(self.manifest, self.assets, output)
        for packet in (output / "packets").iterdir():
            data = study.load(packet / "packet.json")
            rendered = (packet / "review.html").read_text(encoding="utf-8")
            self.assertNotIn('"reference":', rendered)
            self.assertNotIn('"caseId":', rendered)
            self.assertNotIn('"condition":', rendered)
            self.assertNotIn('"stratum":', rendered)
            self.assertNotIn(self.manifest["policy"]["seed"], rendered)
            self.assertNotIn("private-customer-slot", rendered)
            for task in data["tasks"]:
                for asset in task["assets"]:
                    self.assertNotIn("path", asset)
                    self.assertEqual(study.hashlib.sha256((packet / asset["file"]).read_bytes()).hexdigest(), asset["sha256"])
        self.assertTrue((output / "coordinator/study-key.json").exists())

    def test_hash_tampering_fails_before_writing_output(self):
        (self.assets / self.manifest["cases"][0]["originals"][0]["path"]).write_text("changed")
        with self.assertRaisesRegex(ValueError, "ASSET_SIZE_MISMATCH"):
            study.prepare(self.manifest, self.assets, self.root / "denied")
        self.assertFalse((self.root / "denied").exists())

    def test_local_path_escape_is_rejected(self):
        self.manifest["cases"][0]["originals"][0]["path"] = "../private-file"
        with self.assertRaisesRegex(ValueError, "ASSET_OUTSIDE_PRIVATE_ROOT"):
            study.prepare(self.manifest, self.assets, self.root / "denied")

    def test_specimens_sessions_and_bytes_cannot_leak_across_splits(self):
        for field in ("specimenIds", "captureSessionIds", "sourceDigest"):
            manifest = copy.deepcopy(self.manifest)
            training = copy.deepcopy(manifest["cases"][0])
            training["caseId"] = "training-copy"
            training["split"] = "train"
            if field != "specimenIds": training["specimenIds"] = ["different-specimen"]
            if field != "captureSessionIds": training["captureSessionIds"] = ["different-session"]
            if field != "sourceDigest":
                for i, asset in enumerate(training["originals"] + training["enrichment"]): asset["sha256"] = str(i + 7) * 64
            manifest["cases"].append(training)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "SPLIT_LEAKAGE"):
                study.make_plan(manifest)

    def test_related_test_cases_cannot_repeat_exposure(self):
        self.manifest["cases"][1]["specimenIds"] = self.manifest["cases"][0]["specimenIds"]
        with self.assertRaisesRegex(ValueError, "RELATED_TEST_CASES_REQUIRE_ONE_CASE"):
            study.make_plan(self.manifest)

    def test_missing_failed_abstained_timeout_and_wrong_answers_remain_in_denominator(self):
        reviewer = next(iter(self.plan["packets"]))
        own = [a for a in self.plan["assignments"] if a["reviewerToken"] == reviewer]
        rows = [self.response(own[0]), self.response(own[1], value="NOT_OBSERVED", window=None),
                self.response(own[2], status="ABSTAIN", value=None, contradiction=None, window=None, confidencePercent=None),
                self.response(own[3], status="TECHNICAL_FAILURE", value=None, contradiction=None, window=None, confidencePercent=None)]
        second = next(a for a in self.plan["assignments"] if a["reviewerToken"] != reviewer)
        timeout = self.response(second, status="TIMEOUT", value=None, contradiction=None, window=None, confidencePercent=None, elapsedSeconds=120)
        report = study.score(self.plan, [self.submission(own, rows), self.submission([second], [timeout])])
        groups = [g for g in report["groups"] if g["stratum"] is None]
        self.assertEqual(sum(g["assigned"] for g in groups), 16)
        self.assertEqual(sum(g["correct"] for g in groups), 1)
        self.assertEqual(sum(g["incorrectAnswered"] for g in groups), 1)
        self.assertEqual(sum(g["statuses"]["NO_RESPONSE"] for g in groups), 11)
        self.assertEqual(sum(g["statuses"]["ABSTAIN"] for g in groups), 1)
        self.assertEqual(sum(g["statuses"]["TECHNICAL_FAILURE"] for g in groups), 1)
        self.assertEqual(sum(g["statuses"]["TIMEOUT"] for g in groups), 1)
        self.assertFalse(report["qualified"])

    def test_disputed_references_remain_visible_and_not_scored(self):
        self.manifest["cases"][0]["reference"]["state"] = "DISPUTED"
        self.plan = study.make_plan(self.manifest)
        report = study.score(self.plan, self.all_submissions())
        groups = [g for g in report["groups"] if g["stratum"] is None]
        self.assertEqual(sum(g["referenceDisputedAssigned"] for g in groups), 4)
        self.assertEqual(sum(g["correct"] for g in groups), 12)
        self.assertEqual(sum(g["answeredScorable"] for g in groups), 12)

    def test_event_interval_requires_correct_source_and_frozen_tolerance(self):
        assignment = self.plan["assignments"][0]
        good = self.response(assignment, window={"slot": "source-1", "startMs": 1250, "endMs": 1750})
        bad = self.response(assignment, window={"slot": "source-1", "startMs": 1251, "endMs": 1750})
        for response, count in ((good, 1), (bad, 0)):
            report = study.score(self.plan, [self.submission([assignment], [response])])
            self.assertEqual(sum(g["correct"] for g in report["groups"] if g["stratum"] is None), count)
        foreign = self.response(assignment, window={"slot": "source-9", "startMs": 1000, "endMs": 2000})
        with self.assertRaisesRegex(ValueError, "RESPONSE_SOURCE_MISMATCH"):
            study.score(self.plan, [self.submission([assignment], [foreign])])

    def test_conflicts_missingness_and_calibration_denominators(self):
        case = self.manifest["cases"][2]
        case["reference"].update(value="MISSING_VALUE", contradiction=True)
        self.plan = study.make_plan(self.manifest)
        report = study.score(self.plan, [])
        groups = [g for g in report["groups"] if g["stratum"] is None]
        self.assertEqual(sum(g["contradictionNotDetectedOrUnanswered"] for g in groups), 4)
        self.assertEqual(sum(g["missingValueEligibleAssigned"] for g in groups), 4)
        for g in groups:
            self.assertIsNone(g["brierAnsweredScorable"])
            self.assertEqual(g["failurePenalizedSecondsPerScorableAssigned"], 120)

    def test_complete_responses_score_and_pair_agreement_preserve_assignment_pairs(self):
        report = study.score(self.plan, self.all_submissions())
        for group in (g for g in report["groups"] if g["stratum"] is None):
            self.assertEqual(group["correctPerAssigned"], 1)
            self.assertAlmostEqual(group["brierAnsweredScorable"], .04)
            self.assertEqual(group["failurePenalizedSecondsPerScorableAssigned"], 8)
        for group in report["reviewerAgreement"]:
            self.assertEqual(group["assignedPairs"], group["answeredPairs"])
            self.assertEqual(group["answeredPairs"], group["sameObservationAndConflict"])

    def test_duplicate_unknown_foreign_and_wrong_study_responses_are_rejected(self):
        one, other = self.plan["assignments"][:2]
        submission = self.submission([one])
        with self.assertRaisesRegex(ValueError, "DUPLICATE_RESPONSE"):
            study.score(self.plan, [submission, submission])
        invalid = copy.deepcopy(submission); invalid["responses"][0]["assignmentId"] = other["assignmentId"]
        with self.assertRaisesRegex(ValueError, "FOREIGN_ASSIGNMENT"):
            study.score(self.plan, [invalid])
        invalid = copy.deepcopy(submission); invalid["manifestDigest"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "RESPONSE_STUDY_MISMATCH"):
            study.score(self.plan, [invalid])

    def test_changed_key_and_nonfinite_or_identity_response_fields_rejected(self):
        changed = copy.deepcopy(self.plan); changed["assignments"][0]["condition"] = "ORIGINAL_ONLY" if changed["assignments"][0]["condition"] == "ENRICHED" else "ENRICHED"
        with self.assertRaisesRegex(ValueError, "STUDY_KEY_CHANGED"):
            study.score(changed, [])
        submission = self.submission([self.plan["assignments"][0]])
        submission["responses"][0]["confidencePercent"] = float("nan")
        with self.assertRaisesRegex(ValueError, "INVALID_NUMBER"):
            study.score(self.plan, [submission])
        submission["reviewerEmail"] = "must-not-be-collected@example.invalid"
        with self.assertRaisesRegex(ValueError, "UNEXPECTED_FIELDS"):
            study.score(self.plan, [submission])

    def test_unsupported_verdict_and_unbalanced_design_rejected(self):
        for mutator, error in ((lambda m: m["cases"][0]["question"].update(target="FRAUD"), "NEUTRAL_OBSERVATION"),
                               (lambda m: m["policy"].update(reviewerCount=5), "EVEN_REVIEWER"),
                               (lambda m: m["policy"].update(frozenBeforeReview=False), "POLICY_FREEZE"),
                               (lambda m: m["cases"].pop(), "EVEN_TEST_CASES")):
            manifest = copy.deepcopy(self.manifest); mutator(manifest)
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):study.make_plan(manifest)

    def test_json_duplicate_keys_and_output_overwrite_rejected(self):
        target = self.root / "data.json"; target.write_text('{"a":1,"a":2}')
        with self.assertRaisesRegex(ValueError, "DUPLICATE_JSON_KEY"):study.load(target)
        with self.assertRaises(FileExistsError):study.write(target, {"new": True})
        output = self.root / "prepared"; output.mkdir()
        with self.assertRaises(FileExistsError):study.prepare(self.manifest, self.assets, output)

    def test_packet_text_cannot_close_inline_script_and_score_has_no_reviewer_identity(self):
        packet = {"text": "</script><script>fetch('https://bad.invalid')</script>"}
        rendered = study.render_html(packet)
        self.assertEqual(rendered.count("</script>"), 1)
        report = json.dumps(study.score(self.plan, self.all_submissions()))
        for token in self.plan["packets"]:self.assertNotIn(token, report)
        self.assertNotIn(self.manifest["policy"]["seed"], report)

    def test_cli_prepare_and_empty_score_are_actual_offline_roundtrip(self):
        script = Path(study.__file__)
        output = self.root / "cli"
        result = subprocess.run([sys.executable, str(script), "prepare", "--manifest", str(self.assets / "manifest.json"),
                                 "--assets", str(self.assets), "--output", str(output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        scored = self.root / "scored.json"
        result = subprocess.run([sys.executable, str(script), "score", "--key", str(output / "coordinator/study-key.json"),
                                 "--output", str(scored)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum(g["statuses"]["NO_RESPONSE"] for g in study.load(scored)["groups"] if g["stratum"] is None), 16)


if __name__ == "__main__":unittest.main()
