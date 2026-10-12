"""Synthetic filesystem fixtures only. These tests are not physical-study evidence."""
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("physical_intake", Path(__file__).with_name("intake.py"))
intake = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(intake)


class IntakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = datetime(2030, 1, 1, tzinfo=timezone.utc)
        self.protocol_path = self.root / "protocol.json"
        self.freeze_path = self.root / "freeze.json"
        self.intake_path = self.root / "intake.json"
        ref = self.artifact("review.txt", b"SYNTHETIC TEST ONLY - review and consent fixture")
        self.protocol = {
            "schemaVersion": intake.SCHEMA, "studyId": "fixture", "study": "STAGE0_PASSIVE", "dataOrigin": "synthetic-fixture",
            "referenceDigests": intake.references()[2], "evaluationDataAccessed": False,
            "controls": {"mode": "PASSIVE_ONLY", "activeIllumination": False, "automaticFocus": False, "automaticExposure": False},
            "devices": [{"deviceId": "phone-a", "model": "TEST", "osBuild": "TEST", "appBuildSha256": "a" * 64, "nativeStreamProfile": "TEST-ONLY"}],
            "operators": [{"operatorId": "op-a", "consentArtifactId": "review"}], "artifacts": {"review": ref}, "protocolReviewArtifactId": "review",
            "retentionUntil": "2031-01-01T00:00:00Z", "plannedAttempts": [self.attempt("one")],
        }

    def artifact(self, name, data):
        (self.root / name).write_bytes(data)
        return {"path": name, "byteLength": len(data), "sha256": intake.digest(data)}

    def attempt(self, key, **kwargs):
        return dict(attemptId=key, deviceId="phone-a", operatorId="op-a", physicalInstanceId="carton-a", conditionId="light-a", variant="OFF", split="pilot", captureMode="ORDINARY_CONTINUOUS_VIDEO", **kwargs)

    def recorded(self, key="one", **kwargs):
        return dict(attemptId=key, status="RECORDED", source=self.artifact(key + ".bin", b"SYNTHETIC MEDIA " + key.encode()),
                    startedAt="2030-01-01T00:01:00Z", endedAt="2030-01-01T00:02:00Z", captureSessionId="session-" + key,
                    nativeStreamProfile="TEST-ONLY", controls=self.protocol["controls"], recordingInterruptions=0, **kwargs)

    def frozen(self):
        self.protocol_path.write_text(json.dumps(self.protocol), encoding="utf-8")
        return intake.freeze(self.protocol_path, self.root, self.freeze_path, now=self.now)

    def inspect(self, records):
        frozen = self.frozen()
        self.intake_path.write_text(json.dumps({"schemaVersion": intake.SCHEMA, "protocolSha256": frozen["protocolSha256"], "records": records}), encoding="utf-8")
        return intake.inspect_intake(self.protocol_path, self.freeze_path, self.intake_path, self.root, now=self.now + timedelta(hours=1))

    def paired(self):
        self.protocol["study"] = "F08_PASSIVE_COMPARISON"
        self.protocol["comparison"] = {"expectedDetailsCount": 10}
        self.protocol["plannedAttempts"] = [self.attempt("off", pairId="pair-a", position=1), self.attempt("on", pairId="pair-a", position=2)]
        self.protocol["plannedAttempts"][1]["variant"] = "PASSIVE_ON"

    def test_prepare_uses_existing_allocations_and_is_exclusive(self):
        result = intake.prepare(self.root / "packet")
        self.assertEqual((result["plannedLabelInstances"], result["plannedCartonInstances"], result["plannedPrinterUnitSlots"], result["plannedMediaLots"]), (240, 60, 24, 12))
        self.assertEqual(result["measuredSessions"], 0)
        self.assertFalse(result["qualified"])
        with self.assertRaises(FileExistsError): intake.prepare(self.root / "packet")
        protocol, _ = intake.load(self.root / "packet" / "protocol-template.json")
        with self.assertRaisesRegex(ValueError, "review artifact"):
            intake.validate_protocol(protocol, self.root)

    def test_complete_fixture_remains_not_qualified(self):
        result = self.inspect([self.recorded()])
        self.assertEqual(result["state"], "INTAKE_COMPLETE_NOT_QUALIFIED")
        self.assertEqual(result["dataOrigin"], "synthetic-fixture")
        self.assertEqual(result["denominators"]["RECORDED"], 1)
        self.assertFalse(result["qualified"])
        self.assertNotIn(".bin", json.dumps(result))

    def test_every_planned_attempt_stays_in_denominator(self):
        self.protocol["plannedAttempts"] = [self.attempt(key) for key in ("one", "two", "three", "four")]
        result = self.inspect([self.recorded(), {"attemptId": "two", "status": "FAILED", "reason": "power loss"}, {"attemptId": "three", "status": "EXCLUDED", "reason": "operator error"}])
        self.assertEqual(result["denominators"], {"RECORDED": 1, "FAILED": 1, "EXCLUDED": 1, "NOT_RUN": 1})
        self.assertEqual(len(result["unavailableAcquisitions"]), 3)

    def test_failures_need_reason_and_unknown_attempts_rejected(self):
        with self.assertRaisesRegex(ValueError, "require a reason"):
            self.inspect([{"attemptId": "one", "status": "FAILED"}])

    def test_unknown_attempt_rejected(self):
        with self.assertRaisesRegex(ValueError, "unknown or duplicate"):
            self.inspect([self.recorded("unplanned")])

    def test_hash_drift_fails_closed(self):
        record = self.recorded()
        (self.root / "one.bin").write_bytes(b"X" * record["source"]["byteLength"])
        with self.assertRaisesRegex(ValueError, "hash mismatch"): self.inspect([record])

    def test_duplicate_source_is_not_independent_acquisition(self):
        self.protocol["plannedAttempts"].append(self.attempt("two"))
        one, two = self.recorded(), self.recorded("two")
        two["source"] = one["source"]
        with self.assertRaisesRegex(ValueError, "source reused"): self.inspect([one, two])

    def test_absolute_traversal_windows_and_ads_paths_rejected(self):
        ref = self.protocol["artifacts"]["review"]
        for name in ("../review.txt", "/review.txt", "C:/review.txt", "review.txt:ads", "a\\review.txt"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                intake.checked_artifact(dict(ref, path=name), self.root)

    def test_linked_artifact_is_rejected(self):
        link = self.root / "linked.txt"
        try: link.symlink_to(self.root / "review.txt")
        except OSError: self.skipTest("OS does not permit creating a test symlink")
        with self.assertRaisesRegex(ValueError, "linked artifact"):
            intake.checked_artifact(dict(self.protocol["artifacts"]["review"], path="linked.txt"), self.root)

    def test_active_and_numeric_false_controls_rejected(self):
        for value in (True, 0):
            self.protocol["controls"]["automaticFocus"] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "active controls"):
                intake.validate_protocol(self.protocol, self.root)

    def test_accessed_test_data_cannot_be_frozen(self):
        self.protocol["evaluationDataAccessed"] = True
        with self.assertRaisesRegex(ValueError, "after evaluation"): self.frozen()

    def test_expired_retention_rejects_processing(self):
        self.protocol["retentionUntil"] = "2029-12-31T00:00:00Z"
        with self.assertRaisesRegex(ValueError, "expired"): self.frozen()

    def test_recorded_before_freeze_rejected(self):
        record = self.recorded(); record["startedAt"] = "2029-12-31T00:00:00Z"
        with self.assertRaisesRegex(ValueError, "follow the freeze"): self.inspect([record])

    def test_exact_protocol_binding_rejects_reformatting(self):
        frozen = self.frozen()
        self.protocol_path.write_text(json.dumps(self.protocol, indent=2), encoding="utf-8")
        self.intake_path.write_text(json.dumps({"schemaVersion": intake.SCHEMA, "protocolSha256": frozen["protocolSha256"], "records": []}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "exact protocol bytes"):
            intake.inspect_intake(self.protocol_path, self.freeze_path, self.intake_path, self.root, now=self.now + timedelta(hours=1))

    def test_interruption_retained_and_flagged(self):
        record = self.recorded(); record["recordingInterruptions"] = 1
        result = self.inspect([record])
        self.assertEqual(result["denominators"]["RECORDED"], 1)
        self.assertEqual(result["findings"][0]["finding"], "INTERRUPTED_RECORDING_RETAINED")

    def test_randomized_schedule_balanced_reproducible_and_bounded(self):
        schedule = intake.paired_schedule(20, 20261011)
        self.assertEqual(schedule, intake.paired_schedule(20, 20261011))
        self.assertEqual(sum(row["variant"] == "OFF" and row["position"] == 1 for row in schedule), 10)
        self.assertEqual(len({row["attemptId"] for row in schedule}), 40)
        with self.assertRaises(ValueError): intake.paired_schedule(3, 1)

    def test_pair_requires_matched_device_and_condition(self):
        self.paired(); self.protocol["plannedAttempts"][1]["conditionId"] = "different"
        with self.assertRaisesRegex(ValueError, "pair mismatch"): self.frozen()

    def test_failed_pair_arm_is_not_dropped(self):
        self.paired()
        result = self.inspect([self.recorded("off"), {"attemptId": "on", "status": "FAILED", "reason": "unavailable"}])
        self.assertEqual(len(result["pairs"]), 1)
        self.assertFalse(result["pairs"][0]["complete"])
        self.assertNotIn("passiveOnMinusOff", result["pairs"][0])
        self.assertEqual(result["denominators"]["FAILED"], 1)

    def test_pair_metrics_require_reports_and_frozen_denominator(self):
        self.paired()
        metrics = dict(durationMs=30000, batteryUsedPercentagePoints=1, peakMemoryMiB=200, peakTemperatureC=31, frameGapCount=0, droppedFrameCount=0, readableDetails=8, totalDetails=10)
        ref = self.protocol["artifacts"]["review"]
        records = [self.recorded(key, metrics=dict(metrics), decoderReport=ref, blindedReview=ref) for key in ("off", "on")]
        records[1]["metrics"]["readableDetails"] = 9
        result = self.inspect(records)
        self.assertEqual(result["pairs"][0]["passiveOnMinusOff"]["readableDetails"], 1)
        self.assertFalse(result["qualified"])

    def test_changed_detail_denominator_rejected(self):
        self.paired()
        with self.assertRaisesRegex(ValueError, "frozen detail count"):
            self.inspect([self.recorded("off", metrics={"readableDetails": 8, "totalDetails": 11})])

    def test_metrology_tracks_uncertainty_without_qualification(self):
        self.protocol["study"] = "F04_METROLOGY"; self.protocol["plannedAttempts"][0]["attackFamily"] = "unchanged-control"
        record = self.recorded(metrology={"unit": "mm", "referenceMm": 400, "reconstructedMm": 407, "referenceUncertaintyMm": 2, "calibrationArtifactId": "review"})
        result = self.inspect([record])["metrology"][0]
        self.assertEqual(result["declaredToleranceMm"], 8)
        self.assertFalse(result["errorPlusReferenceUncertaintyWithinTolerance"])
        self.assertFalse(result["metrologicallyQualified"])

    def test_metrology_rejects_unbound_calibration_and_wrong_units(self):
        self.protocol["study"] = "F04_METROLOGY"; self.protocol["plannedAttempts"][0]["attackFamily"] = "unchanged-control"
        with self.assertRaisesRegex(ValueError, "mm and a frozen"):
            self.inspect([self.recorded(metrology={"unit": "cm", "calibrationArtifactId": "missing"})])

    def test_split_reuse_and_missing_holdout_ids_are_visible(self):
        self.protocol["study"] = "F04_METROLOGY"
        self.protocol["plannedAttempts"] = [self.attempt("one", attackFamily="same-content-reprint"), self.attempt("two", attackFamily="same-content-reprint")]
        self.protocol["plannedAttempts"][0]["split"] = "train"; self.protocol["plannedAttempts"][1]["split"] = "test"
        result = self.inspect([])
        self.assertTrue(any(row["finding"] == "CROSS_SPLIT_REUSE" and row["field"] == "deviceId" for row in result["findings"]))
        self.assertTrue(any(row["finding"] == "HOLDOUT_ID_MISSING" for row in result["findings"]))

    def test_f01_uses_frozen_specimen_ids_and_split(self):
        self.protocol["study"] = "F01_OPTICAL"
        row = self.protocol["plannedAttempts"][0]
        row.update(attackFamily="same-content-reprint", split="train", plannedLabelId="DIRECT_THERMAL-LOT1-D1-COPY01", plannedCartonId="SINGLE_WALL_KRAFT-01")
        intake.validate_protocol(self.protocol, self.root)
        row["split"] = "test"
        with self.assertRaisesRegex(ValueError, "specimen split differs"):
            intake.validate_protocol(self.protocol, self.root)
        row["plannedLabelId"] = "invented-slot"
        with self.assertRaisesRegex(ValueError, "existing planned"):
            intake.validate_protocol(self.protocol, self.root)

    def test_duplicate_json_keys_and_nonfinite_numbers_rejected(self):
        for data in ('{"a":1,"a":2}', '{"a":NaN}'):
            self.protocol_path.write_text(data)
            with self.assertRaises(ValueError): intake.load(self.protocol_path)


if __name__ == "__main__":
    unittest.main()
