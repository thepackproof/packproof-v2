import datetime as dt
import importlib.util
import json
import os
import stat
from unittest.mock import patch
from pathlib import Path
import plistlib
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("ios_release", Path(__file__).resolve().parents[1] / "scripts/verify-ios-release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
SHA = "a" * 40
BUILD = "12345678-1234-1234-1234-123456789012"
RUN = {"id": 100, "repository": {"full_name": "thepackproof/packproof-v2"}, "path": ".github/workflows/ios.yml",
       "event": "workflow_dispatch", "head_branch": "main", "head_sha": SHA, "status": "completed", "conclusion": "success", "run_number": 61}
EAS = {"id": BUILD, "status": "FINISHED", "platform": "IOS", "distribution": "STORE", "gitCommitHash": SHA,
       "appVersion": "1.0.1", "appBuildVersion": "61", "project": {"id": release.PROJECT_ID}}


class ReleaseVerification(unittest.TestCase):
    def test_run_rejects_untrusted_source_and_nonfinal_states(self):
        self.assertEqual(release.verify_run(RUN, SHA, 100, "thepackproof/packproof-v2"), "61")
        for bad in [{"head_sha": "b" * 40}, {"head_branch": "feature/anything"}, {"event": "pull_request"},
                    {"conclusion": "failure"}, {"status": "in_progress"}, {"path": ".github/workflows/other.yml"},
                    {"run_number": 5}, {"id": 99}, {"repository": {"full_name": "other/repo"}}]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                release.verify_run({**RUN, **bad}, SHA, 100, "thepackproof/packproof-v2")

    def test_metadata_requires_exact_build_not_latest(self):
        self.assertEqual(release.verify_build([EAS], SHA, BUILD, "61"), EAS)
        for bad in [{"id": "99999999-1234-1234-1234-123456789012"}, {"gitCommitHash": "b" * 40},
                    {"status": "IN_PROGRESS"}, {"distribution": "INTERNAL"}, {"platform": "ANDROID"},
                    {"appBuildVersion": "5"}, {"appVersion": "1.0.0"}, {"project": {"id": "other"}}]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                release.verify_build({**EAS, **bad}, SHA, BUILD, "61")
        with self.assertRaises(ValueError):
            release.verify_build([EAS, EAS], SHA, BUILD, "61")

    def test_profile_requires_store_signing_matching_team_and_expiration(self):
        now = dt.datetime(2026, 10, 11, tzinfo=dt.timezone.utc)
        signed = {"application-identifier": release.SIGNING_TEAM + "." + release.APP_ID, "com.apple.developer.team-identifier": release.SIGNING_TEAM, "get-task-allow": False}
        profile = {"TeamIdentifier": [release.SIGNING_TEAM], "ExpirationDate": now + dt.timedelta(days=30), "Entitlements": signed}
        self.assertEqual(release.verify_profile(profile, signed, release.APP_ID, now), release.SIGNING_TEAM)
        for bad in [{"ProvisionedDevices": ["device"]}, {"ProvisionsAllDevices": True}, {"ExpirationDate": now - dt.timedelta(seconds=1)}, {"TeamIdentifier": ["OTHER"]}]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                release.verify_profile({**profile, **bad}, signed, release.APP_ID, now)
        for bad in [{"get-task-allow": True}, {"application-identifier": "TEAM.other.app"}, {"com.apple.developer.team-identifier": "OTHER"}]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                release.verify_profile(profile, {**signed, **bad}, release.APP_ID, now)
        other_signed = {**signed, "application-identifier": "OTHER." + release.APP_ID, "com.apple.developer.team-identifier": "OTHER"}
        with self.assertRaises(ValueError):
            release.verify_profile({**profile, "TeamIdentifier": ["OTHER"], "Entitlements": other_signed}, other_signed, release.APP_ID, now)

    def archive(self, path, info_change=None, config_change=None, extra_path=None, extension_change=None):
        info = {"CFBundleIdentifier": release.APP_ID, "CFBundleShortVersionString": "1.0.1", "CFBundleVersion": "61", "CFBundleSupportedPlatforms": ["iPhoneOS"]}
        config = {"ios": {"bundleIdentifier": release.APP_ID}, "extra": {"packproofBuildSha": SHA, "packproofApiBaseUrl": release.API_URL,
                  "packproofFirstProofExperience": True, "eas": {"projectId": release.PROJECT_ID}}}
        if info_change: info.update(info_change)
        if config_change: config["extra"].update(config_change)
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("Payload/PackProof.app/Info.plist", plistlib.dumps(info))
            archive.writestr("Payload/PackProof.app/EXConstants.bundle/app.config", json.dumps(config))
            extension = {**info, "CFBundleIdentifier": release.APP_ID + ".OrderShare"}
            if extension_change: extension.update(extension_change)
            archive.writestr("Payload/PackProof.app/PlugIns/PackProofOrderShare.appex/Info.plist", plistlib.dumps(extension))
            if extra_path: archive.writestr(extra_path, "unsafe")

    def test_ipa_inspection_keeps_unsigned_fixture_distinct_from_signature_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "fixture.ipa"; self.archive(path)
            result = release.verify_ipa(path, SHA, "61")
            self.assertFalse(result["signatureVerified"])
            self.assertEqual(result["sourceSha"], SHA)
            self.assertRegex(result["ipaSha256"], r"^[a-f0-9]{64}$")

    def test_ipa_rejects_wrong_identity_simulator_old_binary_and_feature_rollback(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "fixture.ipa"
            for change in [{"CFBundleIdentifier": "other.app"}, {"CFBundleVersion": "5"}, {"CFBundleSupportedPlatforms": ["iPhoneSimulator"]}]:
                self.archive(path, info_change=change)
                with self.subTest(change=change), self.assertRaises(ValueError): release.verify_ipa(path, SHA, "61")
            for change in [{"packproofBuildSha": "b" * 40}, {"packproofApiBaseUrl": "https://other.test"}, {"packproofFirstProofExperience": False}]:
                self.archive(path, config_change=change)
                with self.subTest(change=change), self.assertRaises(ValueError): release.verify_ipa(path, SHA, "61")

    def test_ipa_rejects_path_traversal_before_signature_extraction(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "fixture.ipa"
            for extra in ["../escape", "/absolute/escape", "Payload/../escape", "C:/escape"]:
                self.archive(path, extra_path=extra)
                with self.subTest(path=extra), self.assertRaises(ValueError): release.verify_ipa(path, SHA, "61")

    def test_remote_metadata_cannot_hide_reset_app_extension_or_absent_embedded_source(self):
        # Regression: EAS metadata advertised the requested build while remote
        # prebuild lost runner-only variables and produced build 1 without a SHA.
        self.assertEqual(release.verify_build(EAS, SHA, BUILD, "61"), EAS)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "fixture.ipa"
            for kwargs in [{"info_change": {"CFBundleVersion": "1"}},
                           {"extension_change": {"CFBundleVersion": "1"}},
                           {"config_change": {"packproofBuildSha": None}}]:
                self.archive(path, **kwargs)
                with self.subTest(kwargs=kwargs), self.assertRaises(ValueError): release.verify_ipa(path, SHA, "61")

    def test_signature_extraction_restores_original_executable_permissions(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "fixture.ipa"
            entry = zipfile.ZipInfo("Payload/PackProof.app/PackProof")
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o755) << 16
            with zipfile.ZipFile(path, "w") as archive: archive.writestr(entry, b"original-executable")
            destination = Path(folder) / "unpacked"
            with zipfile.ZipFile(path) as archive, patch.object(release.os, "chmod", wraps=os.chmod) as chmod:
                release.extract_for_signature(archive, destination)
                chmod.assert_called_once_with(destination / entry.filename, 0o755)
            self.assertEqual((destination / entry.filename).read_bytes(), b"original-executable")
            if os.name != "nt": self.assertEqual(stat.S_IMODE((destination / entry.filename).stat().st_mode), 0o755)

    def test_signature_extraction_rejects_symlink_special_types_and_privileged_modes(self):
        for mode in [stat.S_IFLNK | 0o777, stat.S_IFCHR | 0o600, stat.S_IFREG | 0o4755, stat.S_IFREG | 0o2755, stat.S_IFDIR | 0o1777]:
            entry = zipfile.ZipInfo("Payload/entry"); entry.external_attr = mode << 16
            with self.subTest(mode=mode), self.assertRaises(ValueError): release.validate_entries([entry])


if __name__ == "__main__":
    unittest.main()
