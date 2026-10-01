"""Synthetic fixtures validate software plumbing only, never optical accuracy."""
import copy
import hashlib
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
import cv2
import numpy as np
from packproof_surface.contracts import InputError, canonical, digest, image_dimensions, media_bytes, read_json
from packproof_surface.engine import load_profile, run, coverage, register
from packproof_surface.dataset import validate_manifest, freeze_manifest, score_blind, evaluate, metric_table, VARIANTS

class SyntheticPlumbingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        rng = np.random.default_rng(2189)
        image = np.clip(rng.normal(150, 35, (700, 1000)), 20, 230).astype(np.uint8)
        # Distinct geometric detail for registration; synthetic texture is not physical identity.
        for _ in range(100):
            center = tuple(int(x) for x in (rng.integers(20, 980), rng.integers(20, 680)))
            cv2.circle(image, center, int(rng.integers(4, 16)), int(rng.integers(30, 220)), 2)
        cv2.imwrite(str(self.root / "a.png"), image)
        moved = cv2.warpAffine(image, np.float32([[1, 0, 1], [0, 1, 1]]), (1000, 700), borderMode=cv2.BORDER_REFLECT)
        cv2.imwrite(str(self.root / "b.png"), moved)
        positions = [(10, 10), (270, 10), (530, 10), (10, 350), (400, 350)]
        groups = ["print", "print", "carton", "carton", "context"]
        self.regions = [{"id": f"r{i}", "sourceId": "a", "group": group,
                         "polygon": [[x, y], [x+220, y], [x+220, y+220], [x, y+220]],
                         "process": "inkjet" if group == "print" else "substrate", "trackId": f"t{i}"}
                        for i, ((x, y), group) in enumerate(zip(positions, groups))]
        self.enrollment = self.capture("a.png", "a")
        self.observation = self.capture("b.png", "b")
        self.job = {"schemaVersion": "surface-job/1", "jobId": "test-synthetic-only", "profileId": "research-paper-v1", "operation": "compare",
                    "enrollment": self.enrollment, "observation": self.observation}

    def tearDown(self):
        self.temp.cleanup()

    def capture(self, name, sid):
        regions = copy.deepcopy(self.regions)
        for region in regions:
            region["sourceId"] = sid
        return {"captureProfileId": "synthetic-plumbing-only", "acquisition": "supplemental",
                "sources": [{"sourceId": sid, "mediaPath": name, "sha256": hashlib.sha256((self.root/name).read_bytes()).hexdigest(), "frameTimeMs": 0}],
                "regions": regions, "requiredGroups": ["print", "carton", "context"]}

    def test_repeatable_and_always_unqualified(self):
        a, b = run(self.job, self.root), run(self.job, self.root)
        self.assertEqual(canonical(a), canonical(b))
        self.assertEqual(a["status"], "inconclusive")
        self.assertIsNone(a["customerFinding"])
        self.assertTrue(all(v["status"] == "inconclusive" for v in a["scopeResults"].values()))
        self.assertTrue(any(r.get("researchResidualMedian") is not None for r in a["regionResults"]))
        self.assertEqual(hashlib.sha256(a["artifactCanonicalJson"].encode()).hexdigest(), a["artifactSha256"])
        template = a["templates"]["enrollment"]
        self.assertEqual(hashlib.sha256(template["canonicalJson"].encode()).hexdigest(), template["artifactSha256"])

    def test_missing_carton_never_hidden_by_label(self):
        self.job["observation"]["regions"] = [r for r in self.observation["regions"] if r["group"] != "carton"]
        result = run(self.job, self.root)
        self.assertFalse(result["coverage"]["carton"]["completeForResearch"])
        self.assertIn("required_coverage_missing", " ".join(result["scopeResults"]["assembly"]["reasons"]))
        self.assertEqual(len([r for r in result["regionResults"] if r["group"] == "carton"]), 2)

    def test_caller_cannot_weaken_required_groups(self):
        self.job["enrollment"]["requiredGroups"] = ["print"]
        self.job["observation"]["regions"] = []
        result = run(self.job, self.root)
        self.assertEqual(set(result["coverage"]), {"print", "carton", "context"})

    def test_digest_substitution_rejected(self):
        self.job["enrollment"]["sources"][0]["sha256"] = "a"*64
        with self.assertRaises(InputError):
            run(self.job, self.root)

    def test_path_escape_and_symlink_rejected(self):
        for path in ("../a.png", str(self.root / "a.png")):
            bad = copy.deepcopy(self.job)
            bad["enrollment"]["sources"][0]["mediaPath"] = path
            with self.assertRaises(InputError):
                run(bad, self.root)
        (self.root/"link.png").symlink_to(self.root/"a.png")
        self.job["enrollment"]["sources"][0]["mediaPath"] = "link.png"
        with self.assertRaises(InputError):
            run(self.job, self.root)

    def test_replayed_bytes_flagged(self):
        self.job["observation"] = copy.deepcopy(self.enrollment)
        result = run(self.job, self.root)
        self.assertIn("identical_media_bytes_reused_no_fresh_observation_assurance", result["scopeResults"]["assembly"]["reasons"])
        self.assertEqual(result["status"], "inconclusive")

    def test_tiny_region_is_unavailable_without_upscaling(self):
        self.job["enrollment"]["regions"][0]["polygon"] = [[0,0],[10,0],[10,10],[0,10]]
        result = run(self.job, self.root)
        first = result["templates"]["enrollment"]["regions"][0]
        self.assertEqual(first["qualityReasons"], ["insufficient_native_pixels"])
        self.assertNotIn("descriptor", first)

    def test_auto_region_proposals_are_scoped_and_unqualified(self):
        self.job["enrollment"]["regions"] = []
        self.job["enrollment"]["hints"] = [{"sourceId":"a", "labelPolygon":[[250,180],[650,180],[650,520],[250,520]],
            "barcodePolygon":[[300,220],[550,220],[550,300],[300,300]], "printProcess":"inkjet", "association":"same_frame_expected_barcode"}]
        result = run(self.job, self.root)
        template=result["templates"]["enrollment"]
        self.assertEqual(len(template["regions"]),5)
        self.assertFalse(template["discovery"][0]["physicalAssociationVerified"])
        self.assertEqual({r["group"] for r in template["regions"]},{"print","carton","context"})
        self.assertEqual(result["status"],"inconclusive")

    def test_native_shaped_context_and_barcode_regions_gain_missing_candidates(self):
        self.job["enrollment"]["regions"] = [
            {"id":"native-context-0","sourceId":"a","group":"context","polygon":[[0,0],[999,0],[999,699],[0,699]],"process":"substrate"},
            {"id":"native-print-0","sourceId":"a","group":"print","polygon":[[300,220],[550,220],[550,300],[300,300]],"process":"unknown"}]
        self.job["enrollment"]["hints"] = [{"sourceId":"a","labelPolygon":[[250,180],[650,180],[650,520],[250,520]],
            "barcodePolygon":[[300,220],[550,220],[550,300],[300,300]],"association":"same_frame_expected_barcode","printProcess":"unknown"}]
        template=run(self.job,self.root)["templates"]["enrollment"]
        self.assertEqual({group:sum(r["group"]==group for r in template["regions"]) for group in ("print","carton","context")},
                         {"print":2,"carton":2,"context":1})
        self.assertTrue(all(not r["usableForResearch"] for r in template["regions"] if r["group"]=="print"))
        self.assertTrue(any(r["id"]=="native-context-0" for r in template["regions"]))

    def test_ambiguous_geometry_proposes_nothing(self):
        self.job["enrollment"]["regions"] = []
        self.job["enrollment"]["hints"] = [{"sourceId":"a", "barcodePolygon":[[300,220],[550,220],[550,300],[300,300]], "association":"ambiguous"}]
        result=run(self.job,self.root)
        self.assertEqual(result["templates"]["enrollment"]["regions"],[])
        self.assertEqual(result["status"],"unsupported")

    def test_label_outline_discovery_uses_actual_image_geometry(self):
        from packproof_surface.discovery import discover_label
        image=np.full((600,800),105,dtype=np.uint8)
        cv2.rectangle(image,(200,150),(600,450),235,-1)
        for x in range(300,501,8):
            cv2.rectangle(image,(x,220),(x+3,300),25,-1)
        quad,diagnostic=discover_label(image,[[295,215],[510,215],[510,305],[295,305]])
        self.assertIsNotNone(quad)
        self.assertEqual(diagnostic["status"],"candidate_only")
        self.assertFalse(diagnostic["materialConfirmed"])

    def test_profile_file_cannot_enable_conclusions(self):
        profile=load_profile("research-paper-v1")
        profile["qualification"]="qualified"
        with patch("packproof_surface.engine.read_json",return_value=profile):
            with self.assertRaises(InputError):
                load_profile("research-paper-v1")

    def test_repeated_track_cannot_satisfy_region_count(self):
        self.job["enrollment"]["regions"][1]["trackId"]="t0"
        result=run(self.job,self.root)
        self.assertEqual(result["coverage"]["print"]["usableEnrollmentRegions"],1)
        self.assertFalse(result["coverage"]["print"]["completeForResearch"])

    def test_nonfinite_and_duplicate_json_rejected(self):
        p = self.root/"bad.json"
        for bad in ('{"x":NaN}', '{"x":1,"x":2}'):
            p.write_text(bad)
            with self.assertRaises(InputError):
                read_json(p)

    def test_oversized_png_rejected_before_decode(self):
        payload = b"\x89PNG\r\n\x1a\n"+struct.pack(">I",13)+b"IHDR"+struct.pack(">II",100000,100000)+bytes([8,2,0,0,0])+b"\x00"*4
        (self.root/"huge.png").write_bytes(payload)
        src={"mediaPath":"huge.png","sha256":hashlib.sha256(payload).hexdigest()}
        with self.assertRaises(InputError):
            media_bytes(self.root,src,load_profile("research-paper-v1")["engineeringBounds"])

    def test_cli_actual_process(self):
        inp, out = self.root/"job.json", self.root/"result.json"
        inp.write_bytes(canonical(self.job))
        command=[sys.executable,"-m","packproof_surface","--input",str(inp),"--output",str(out),"--media-root",str(self.root)]
        completed=subprocess.run(command,capture_output=True,text=True,timeout=40)
        self.assertEqual(completed.returncode,0,completed.stderr)
        result=json.loads(out.read_text())
        self.assertEqual(result["status"],"inconclusive")
        self.assertEqual(completed.stdout,"")

    def manifest(self):
        entries=[]
        for sid, capture in (("a",self.enrollment),("b",self.observation)):
            entries.append({"id":sid,"split":"blind","synthetic":True,"acquisitionMode":"passive_video","printProcess":"inkjet",
                "physicalPrintId":sid,"labelSubstrateId":sid,"cartonId":sid,"assemblyId":sid,"shipmentLegId":"outbound",
                "designId":"same-design","nominalContentId":"same-tracking-content","printerUnitId":"synthetic-printer","mediaLotId":"synthetic-lot",
                "captureSessionId":sid,"operatorId":"synthetic-operator","deviceFamily":"synthetic-device","capture":capture})
        return {"schemaVersion":"surface-dataset/1","captures":entries,"pairs":[{"id":"p1","split":"blind","enrollmentId":"a","observationId":"b"}],"splitPolicy":{"disjointDomains":["captureSessionId"]}}

    def test_dataset_catches_identity_leakage(self):
        manifest=self.manifest()
        manifest["captures"][1]["split"]="development"
        manifest["captures"][1]["physicalPrintId"]="a"
        result=validate_manifest(manifest)
        self.assertFalse(result["valid"])
        self.assertTrue(any("Split leakage" in e for e in result["errors"]))

    def test_blinded_pipeline_and_no_synthetic_accuracy(self):
        manifest=self.manifest()
        frozen=freeze_manifest(manifest)
        predictions=score_blind(manifest,frozen,self.root,"blind")
        self.assertTrue(all(v=="inconclusive" for v in predictions["predictions"][0]["researchDecisions"].values()))
        truth={"schemaVersion":"surface-truth/1","datasetSha256":digest(manifest),"predictionsSha256":predictions["artifactSha256"],
            "pairs":[{"pairId":"p1","labelSame":False,"cartonSame":False,"assemblySame":False,"attackFamily":"synthetic-only","independentTrial":False}]}
        report=evaluate(predictions,truth)
        self.assertEqual(report["physicalTrials"],0)
        self.assertEqual(report["syntheticPlumbingTrials"],1)
        self.assertFalse(report["productionEligible"])
        self.assertIsNone(report["metrics"]["complete_system"]["assembly"]["falseConsistencyWholeFlow"]["rate"])
        bad=copy.deepcopy(frozen)
        bad["thresholds"]["barcode_only"]={"differenceAtOrBelow":0,"consistentAtOrAbove":0.8}
        with self.assertRaises(InputError):
            score_blind(manifest,bad,self.root,"blind")

    def test_zero_abstention_errors_dont_qualify(self):
        rows=[({"researchDecisions":{"complete_system":"inconclusive"}}, {"assemblySame":False,"independentTrial":True,"independenceUnit":str(i)}) for i in range(30000)]
        metrics=metric_table(rows,"complete_system","assembly")
        self.assertFalse(metrics["rareErrorTargetEstablished"])
        self.assertEqual(metrics["conclusiveCoverage"]["rate"],0)

if __name__ == "__main__":
    unittest.main()
