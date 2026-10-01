"""Protocol tamper tests only: opaque bytes are not optical/physical validation."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("surface_verify", Path(__file__).with_name("surface-verify.py"))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def seal(value, **metadata):
    raw = canonical(value)
    return {**metadata, "canonicalJson": raw, "sha256": verifier.sha(raw.encode())}


def fixture():
    source = {"sourceId": "source-1", "sha256": verifier.sha(b"synthetic protocol bytes"),
              "byteSize": len(b"synthetic protocol bytes"), "contentType": "image/png",
              "objectVersionId": "version-1", "availability": "available", "mediaPath": "source-1.png"}
    root = seal({"version": 1, "proofId": "proof-1", "evidence": []})
    enrollment = seal({"id": "enrollment-1", "proofId": "proof-1", "kind": "enrollment",
                       "sources": [{"sourceId": "source-1", "sha256": source["sha256"]}],
                       "sourceDigests": [{"sourceId": "source-1", "sha256": source["sha256"], "byteSize": source["byteSize"]}]},
                      id="enrollment-1", kind="enrollment")
    observation = seal({"id": "observation-1", "proofId": "proof-1", "kind": "observation",
                        "enrollmentId": "enrollment-1", "enrollmentSha256": enrollment["sha256"]},
                       id="observation-1", kind="observation")
    comparison = seal({"id": "comparison-1", "proofId": "proof-1", "kind": "comparison",
                       "enrollmentId": "enrollment-1", "enrollmentSha256": enrollment["sha256"],
                       "observationId": "observation-1", "observationSha256": observation["sha256"]},
                      id="comparison-1", kind="comparison")
    template = seal({"schemaVersion": "surface-template/1", "qualification": "unqualified", "regions": []}, id="template-1")
    analysis = seal({"id": "analysis-1", "proofId": "proof-1", "recordId": "comparison-1",
                     "sourceRecordSha256": comparison["sha256"], "sourceDigests": [{"sourceId": "source-1", "sha256": source["sha256"]}],
                     "result": {"status": "inconclusive", "qualification": "unqualified",
                                "templateDigests": {"enrollment": template["sha256"], "observation": None}}},
                    id="analysis-1", signature=None)
    extensions = []
    subjects = [("source", source["sourceId"], {"sourceId": source["sourceId"], "sourceSha256": source["sha256"], "byteSize": source["byteSize"]})]
    subjects += [(item["kind"], item["id"], {"recordId": item["id"], "recordSha256": item["sha256"]}) for item in (enrollment, observation, comparison)]
    subjects += [("analysis", analysis["id"], {"analysisSha256": analysis["sha256"]})]
    for index, (kind, subject, facts) in enumerate(subjects, 1):
        previous = extensions[-1]["sha256"] if extensions else None
        value = {"schemaVersion": "surface-extension/1", "id": f"extension-{index}", "proofId": "proof-1",
                 "sequence": index, "subjectId": subject, "kind": kind, "previousSha256": previous,
                 "rootManifestSha256": root["sha256"], **facts}
        extensions.append(seal(value, id=value["id"], sequence=index, previousSha256=previous,
                               rootManifestSha256=root["sha256"], signature=None))
    return {"schemaVersion": "surface-export/1", "proofId": "proof-1", "root": root,
            "sources": [source], "records": [enrollment, observation, comparison], "templates": [template],
            "analyses": [analysis], "extensions": extensions, "limitations": []}


def attach_private_artifact(document):
    template = document["templates"][0]
    payload = {"schemaVersion": "surface-result/1", "jobId": "job-1", "floatValue": 1.0,
               "templates": {"enrollment": {"canonicalJson": template["canonicalJson"], "artifactSha256": template["sha256"]}, "observation": None}}
    artifact = {**payload, "artifactCanonicalJson": canonical(payload), "artifactSha256": verifier.sha(canonical(payload).encode())}
    analysis_value = json.loads(document["analyses"][0]["canonicalJson"])
    analysis_value["jobId"] = "job-1"
    analysis_value["result"]["artifactSha256"] = artifact["artifactSha256"]
    document["analyses"][0] = seal(analysis_value, id="analysis-1", signature=None)
    extension = document["extensions"][-1]
    extension_value = json.loads(extension["canonicalJson"])
    extension_value["analysisSha256"] = document["analyses"][0]["sha256"]
    document["extensions"][-1] = seal(extension_value, **{k: v for k, v in extension.items() if k not in {"canonicalJson", "sha256"}})
    document["templates"] = []
    return artifact


class SurfaceIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.export = fixture()
        self.root = self.export["root"]["sha256"]
        self.head = self.export["extensions"][-1]["sha256"]

    def check(self, doc=None, **kwargs):
        return verifier.verify(doc or self.export, expected_root=self.root, expected_head=self.head, expected_proof="proof-1", **kwargs)

    def test_independent_pins_and_exact_original(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "source-1.png").write_bytes(b"synthetic protocol bytes")
            result = self.check(media_dir=folder)
        self.assertEqual(result["status"], "INTEGRITY_CHECKED")
        self.assertTrue(result["rootUnchangedAgainstIndependentDigest"])
        self.assertTrue(result["completeOriginals"])
        self.assertEqual(result["templatesChecked"], 1)
        self.assertFalse(result["allExtensionSignaturesVerified"])
        self.assertEqual(result["physicalAccuracy"], "NOT_EVALUATED")

    def test_no_pin_is_only_self_consistency(self):
        result = verifier.verify(self.export)
        self.assertEqual(result["status"], "SELF_CONSISTENT_UNTRUSTED")
        self.assertFalse(result["completeOriginals"])

    def test_each_exact_byte_artifact_tamper(self):
        for name in ("records", "templates", "analyses", "extensions"):
            with self.subTest(name=name):
                edited = copy.deepcopy(self.export)
                edited[name][0]["canonicalJson"] += " "
                with self.assertRaisesRegex(verifier.Invalid, "digest mismatch"):
                    self.check(edited)

    def test_rewritten_root_even_with_matching_local_hash_fails_pin(self):
        self.export["root"] = seal({"version": 1, "proofId": "proof-1", "evidence": ["forged"]})
        with self.assertRaisesRegex(verifier.Invalid, "Frozen root differs"):
            self.check()

    def test_source_bytes_and_source_commitments(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "source-1.png").write_bytes(b"X" * len(b"synthetic protocol bytes"))
            with self.assertRaisesRegex(verifier.Invalid, "Source media digest mismatch"):
                self.check(media_dir=folder)
        self.export["sources"][0]["sha256"] = "f" * 64
        with self.assertRaisesRegex(verifier.Invalid, "source commitment differs"):
            self.check()

    def test_chain_reorder_duplicate_truncation(self):
        edited = copy.deepcopy(self.export)
        edited["extensions"][1:3] = reversed(edited["extensions"][1:3])
        with self.assertRaises(verifier.Invalid):
            self.check(edited)
        edited = copy.deepcopy(self.export)
        edited["extensions"].append(edited["extensions"][-1])
        with self.assertRaises(verifier.Invalid):
            self.check(edited)
        # A maliciously truncated snapshot also removes the omitted analysis inventory.
        edited = copy.deepcopy(self.export)
        edited["extensions"].pop()
        edited["analyses"] = []
        edited["templates"] = []
        with self.assertRaisesRegex(verifier.Invalid, "Extension head differs"):
            self.check(edited)

    def test_missing_and_foreign_subject(self):
        self.export["records"].pop()
        with self.assertRaises(verifier.Invalid):
            self.check()
        doc = fixture()
        value = json.loads(doc["analyses"][0]["canonicalJson"])
        value["proofId"] = "foreign-proof"
        doc["analyses"][0] = seal(value, id="analysis-1")
        with self.assertRaisesRegex(verifier.Invalid, "Analysis Proof identity differs"):
            self.check(doc)

    def test_duplicate_json_key(self):
        with self.assertRaisesRegex(verifier.Invalid, "Duplicate JSON member"):
            verifier.parse(b'{"proofId":"a","proofId":"b"}')

    def test_resealed_template_substitution_still_fails_binding(self):
        self.export["templates"][0] = seal({"schemaVersion": "surface-template/1", "regions": ["forged"]}, id="template-1")
        with self.assertRaisesRegex(verifier.Invalid, "absent from analysis commitments"):
            self.check()

    def test_withheld_template_is_explicit_replay_limitation(self):
        expected = self.export["templates"][0]["sha256"]
        self.export["templates"] = []
        result = self.check()
        self.assertEqual(result["templatesChecked"], 0)
        self.assertEqual(result["omittedTemplateDigests"], [expected])

    def test_incorrect_independent_tenant_rejected(self):
        with self.assertRaisesRegex(verifier.Invalid, "tenant identity differs"):
            self.check(expected_tenant="unrelated-tenant")

    def test_private_artifact_exact_strings_verify_and_tamper_fails(self):
        artifact = attach_private_artifact(self.export)
        self.head = self.export["extensions"][-1]["sha256"]
        result = self.check(private_artifacts=[artifact])
        self.assertEqual(result["privateResultArtifactsChecked"], 1)
        self.assertEqual(result["templatesChecked"], 1)
        self.assertEqual(result["omittedTemplateDigests"], [])
        # 1.0 and 1 are numerically equal but are different committed exact bytes.
        artifact["artifactCanonicalJson"] = artifact["artifactCanonicalJson"].replace('"floatValue":1.0', '"floatValue":1')
        with self.assertRaisesRegex(verifier.Invalid, "digest mismatch"):
            self.check(private_artifacts=[artifact])

    def test_resealed_private_artifact_cannot_replace_committed_result(self):
        artifact = attach_private_artifact(self.export)
        self.head = self.export["extensions"][-1]["sha256"]
        artifact["artifactCanonicalJson"] += " "
        artifact["artifactSha256"] = verifier.sha(artifact["artifactCanonicalJson"].encode())
        with self.assertRaisesRegex(verifier.Invalid, "differs from committed analysis"):
            self.check(private_artifacts=[artifact])

    def test_media_path_traversal_and_symlink(self):
        with tempfile.TemporaryDirectory() as folder:
            self.export["sources"][0]["mediaPath"] = "../outside.png"
            with self.assertRaisesRegex(verifier.Invalid, "relative and contained"):
                self.check(media_dir=folder)
            path = Path(folder, "source-1.png")
            path.symlink_to(Path(folder, "outside.png"))
            self.export["sources"][0]["mediaPath"] = "source-1.png"
            with self.assertRaisesRegex(verifier.Invalid, "symlinks"):
                self.check(media_dir=folder)

    def test_expired_original_is_never_complete(self):
        self.export["sources"][0]["availability"] = "expired"
        self.export["sources"][0]["mediaPath"] = None
        result = self.check()
        self.assertFalse(result["completeOriginals"])
        self.assertEqual(result["omissions"][0]["reason"], "expired")


if __name__ == "__main__":
    unittest.main()
