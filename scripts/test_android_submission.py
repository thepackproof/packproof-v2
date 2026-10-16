import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("android_submission", Path(__file__).with_name("verify-android-submission.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
SELECTION = {"sourceSha": "a" * 40, "aabSha256": "b" * 64, "easBuildId": "12345678-1234-1234-1234-123456789012",
             "archiveRunId": 100, "version": "1.0.1", "versionCode": 68, "package": release.APP_ID,
             "track": "production", "releaseStatus": "completed", "changesNotSentForReview": False}
RUN = {"id": 100, "repository": {"full_name": release.REPOSITORY}, "path": ".github/workflows/android-aab.yml",
       "event": "push", "head_branch": "main", "head_sha": SELECTION["sourceSha"], "status": "completed", "conclusion": "success"}
BUILD = {"id": SELECTION["easBuildId"], "gitCommitHash": SELECTION["sourceSha"], "status": "FINISHED", "platform": "ANDROID",
         "distribution": "STORE", "buildProfile": "production", "appIdentifier": release.APP_ID, "appVersion": "1.0.1",
         "appBuildVersion": "68", "project": {"id": release.PROJECT_ID}}
CONFIG = {"version": "1.0.1", "android": {"package": release.APP_ID, "versionCode": 68, "allowBackup": False, "usesCleartextTraffic": False}, "extra": {
    "packproofBuildSha": SELECTION["sourceSha"], "packproofApiBaseUrl": release.API_URL,
    "packproofMobileTaskUx": True, "packproofFirstProofExperience": True,
    "packproofResearch": False, "packproofResearchProduction": True, "packproofResearchProfile": "capture-receipts-v1",
    "eas": {"projectId": release.PROJECT_ID}}}


class AndroidSubmission(unittest.TestCase):
    def test_only_explicit_production_selection_is_accepted(self):
        release.verify_selection(SELECTION)
        for bad in [{"sourceSha": "latest"}, {"aabSha256": ""}, {"versionCode": 67}, {"package": "other.app"},
                    {"track": "internal"}, {"releaseStatus": "draft"}, {"changesNotSentForReview": True}, {"archiveRunId": "100"}]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                release.verify_selection({**SELECTION, **bad})

    def test_requires_successful_exact_main_archive(self):
        release.verify_run(RUN, SELECTION)
        for bad in [{"id": 99}, {"head_sha": "c" * 40}, {"event": "pull_request"}, {"head_branch": "release/other"},
                    {"conclusion": "failure"}, {"status": "in_progress"}, {"path": ".github/workflows/other.yml"},
                    {"repository": {"full_name": "other/repo"}}]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                release.verify_run({**RUN, **bad}, SELECTION)

    def test_requires_exact_store_build_identity(self):
        release.verify_build([BUILD], SELECTION)
        for key in BUILD:
            with self.subTest(key=key), self.assertRaises((ValueError, AttributeError)):
                release.verify_build({**BUILD, key: {} if key == "project" else "wrong"}, SELECTION)
        with self.assertRaises(ValueError): release.verify_build([BUILD, BUILD], SELECTION)

    def test_rejects_research_missing_flags_wrong_api_and_wrong_source_in_actual_config(self):
        release.verify_config(CONFIG, SELECTION)
        for key in CONFIG["extra"]:
            value = copy.deepcopy(CONFIG); del value["extra"][key]
            with self.subTest(key=key), self.assertRaises(ValueError): release.verify_config(value, SELECTION)
        for bad in [{"packproofBuildSha": "c" * 40}, {"packproofResearch": True}, {"packproofInternalReview": True},
                    {"packproofApiBaseUrl": "https://other.test"}, {"packproofMobileTaskUx": 1}]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                release.verify_config({**CONFIG, "extra": {**CONFIG["extra"], **bad}}, SELECTION)

    def test_verifier_matches_the_actual_production_config_contract(self):
        root = Path(__file__).resolve().parents[1]
        script = '''
          const profiles = require('./mobile/eas.json').build;
          const layers = [];
          for (let name = 'production'; name; name = profiles[name].extends) layers.unshift(profiles[name].env || {});
          Object.assign(process.env, ...layers, {EAS_BUILD_PROFILE: 'production', EAS_BUILD_PLATFORM: 'android',
            EAS_BUILD: 'true', EAS_BUILD_GIT_COMMIT_HASH: 'a'.repeat(40), PACKPROOF_ANDROID_VERSION_CODE: '68'});
          process.stdout.write(JSON.stringify(require('./mobile/app.config.js').expo));
        '''
        config = json.loads(subprocess.check_output(["node", "-e", script], cwd=root, env={"PATH": os.environ["PATH"]}, text=True))
        release.verify_config(config, SELECTION)

    def test_bundle_bytes_must_match_selection_and_archive_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.aab"
            with zipfile.ZipFile(path, "w") as archive: archive.writestr("base/assets/app.config", json.dumps(CONFIG))
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            selection = {**SELECTION, "aabSha256": digest}
            checksums = f"{digest}  dist/packproof-1.0.1-68.aab\n"
            self.assertEqual(release.verify_bundle(path, checksums, selection), digest)
            with self.assertRaises(ValueError): release.verify_bundle(path, checksums, SELECTION)
            with self.assertRaises(ValueError): release.verify_bundle(path, checksums.replace(digest, "c" * 64), selection)
            with self.assertRaises(ValueError): release.verify_bundle(path, checksums + checksums, selection)


if __name__ == "__main__":
    unittest.main()
