"""Release guard regression for the native record-conversion failure in Android 64."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "release_check", Path(__file__).parents[1] / "scripts/check-aab-release.py"
)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
FIELD = "expo.modules.kotlin.records.Field"


class AndroidRecordAnnotationTest(unittest.TestCase):
    def test_rejects_observed_release_64_mapping(self):
        # Actual release 64 DEX: WritingOptions.getEncoding$annotations uses d9.b.
        self.assertFalse(release.check_reflection_annotation({FIELD: "d9.b"})["preserved"])

    def test_rejects_absent_annotation(self):
        self.assertFalse(release.check_reflection_annotation({})["preserved"])

    def test_allows_other_classes_to_remain_obfuscated(self):
        result = release.check_reflection_annotation({FIELD: FIELD, "example.OrdinaryClass": "a.b"})
        self.assertTrue(result["preserved"])


if __name__ == "__main__":
    unittest.main()
