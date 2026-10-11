#!/usr/bin/env python3
"""Fail closed before uploading an exact, source-bound iOS archive to Apple."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import stat
import subprocess
import tempfile
import zipfile

APP_ID = "com.packproof.mobile"
PROJECT_ID = "0196c3f7-cb3a-472c-99be-825558f227e8"
API_URL = "https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws"
SIGNING_TEAM = "AAY67GYL4D"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_run(run, source_sha, run_id, repository):
    require(bool(re.fullmatch(r"[a-f0-9]{40}", source_sha)), "Invalid source revision")
    require(str(run.get("id")) == str(run_id), "Archive run ID does not match")
    require(run.get("repository", {}).get("full_name") == repository, "Archive repository does not match")
    require(run.get("path") == ".github/workflows/ios.yml", "Archive was not produced by the iOS workflow")
    require(run.get("event") == "workflow_dispatch" and run.get("head_branch") == "main", "Archive must be dispatched from main")
    require(run.get("head_sha") == source_sha, "Archive source revision does not match")
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "Archive workflow did not succeed")
    number = run.get("run_number")
    require(type(number) is int and number > 5, "Build number must advance beyond uploaded build 5")
    return str(number)


def verify_build(value, source_sha, build_id, build_number):
    require(bool(re.fullmatch(r"[a-f0-9-]{36}", build_id)), "Invalid EAS build ID")
    require(not isinstance(value, list) or len(value) == 1, "Expected one EAS build")
    build = value[0] if isinstance(value, list) else value
    require(build.get("id") == build_id, "EAS build ID does not match the selected archive")
    require(build.get("status") == "FINISHED" and build.get("platform") == "IOS", "Expected a finished iOS build")
    require(build.get("distribution") == "STORE", "Expected an App Store distribution build")
    require(build.get("gitCommitHash") == source_sha, "EAS source revision does not match")
    require(build.get("appVersion") == "1.0.1", "Unexpected marketing version")
    require(str(build.get("appBuildVersion")) == build_number, "EAS build number does not match the archive run")
    if build.get("project", {}).get("id"):
        require(build["project"]["id"] == PROJECT_ID, "EAS project does not match")
    return build


def verify_info(info, build_number, identifier=APP_ID):
    require(info.get("CFBundleIdentifier") == identifier, "Unexpected Apple bundle identifier")
    require(info.get("CFBundleShortVersionString") == "1.0.1", "Unexpected IPA marketing version")
    require(str(info.get("CFBundleVersion")) == build_number, "Unexpected IPA build number")
    require(info.get("CFBundleSupportedPlatforms") == ["iPhoneOS"], "IPA must contain a device build")


def verify_config(config, source_sha):
    require(config.get("ios", {}).get("bundleIdentifier") == APP_ID, "Embedded app configuration identity does not match")
    extra = config.get("extra", {})
    require(extra.get("packproofBuildSha") == source_sha, "IPA does not embed the exact source revision")
    require(extra.get("packproofApiBaseUrl") == API_URL, "IPA endpoint is not the approved production API")
    require(extra.get("packproofFirstProofExperience") is True, "IPA first-proof feature is not enabled")
    require(extra.get("eas", {}).get("projectId") == PROJECT_ID, "Embedded Expo project does not match")


def verify_profile(profile, entitlements, identifier, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    expires = profile.get("ExpirationDate")
    require(isinstance(expires, dt.datetime), "Provisioning profile has no expiration")
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=dt.timezone.utc)
    require(expires > now, "Provisioning profile has expired")
    require(not profile.get("ProvisionedDevices") and not profile.get("ProvisionsAllDevices"), "Expected App Store provisioning")
    teams = profile.get("TeamIdentifier", [])
    require(teams == [SIGNING_TEAM], "Provisioning team is not the existing PackProof Apple team")
    expected = f"{teams[0]}.{identifier}"
    for value in [profile.get("Entitlements", {}), entitlements]:
        require(value.get("application-identifier") == expected, "Signing identity differs from provisioning")
        require(value.get("com.apple.developer.team-identifier") == teams[0], "Signing team differs from provisioning")
        require(value.get("get-task-allow") is False, "Development/debug signing is not allowed")
    return teams[0]


def validate_entries(entries):
    require(len(entries) <= 50000 and sum(item.file_size for item in entries) <= 2_000_000_000, "IPA exceeds inspection limits")
    for item in entries:
        name = PurePosixPath(item.filename)
        require(not name.is_absolute() and ".." not in name.parts and "\\" not in item.filename and ":" not in item.filename, "Unsafe IPA archive path")
        mode = item.external_attr >> 16
        require(stat.S_IFMT(mode) in [0, stat.S_IFREG, stat.S_IFDIR], "IPA special entries require separate inspection")
        require(not mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX), "IPA special permission bits are not allowed")


def extract_for_signature(archive, folder):
    entries = archive.infolist()
    validate_entries(entries)
    archive.extractall(folder)
    # ZipFile does not restore executable permission bits. Codesign inspects the
    # actual bundle, so restore only the reviewed ordinary POSIX permission bits.
    for item in entries:
        mode = stat.S_IMODE(item.external_attr >> 16) & 0o777
        if mode:
            os.chmod(Path(folder) / item.filename, mode)


def verify_ipa(path, source_sha, build_number, verify_signature=False):
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        validate_entries(entries)
        names = archive.namelist()
        roots = [name for name in names if re.fullmatch(r"Payload/[^/]+\.app/Info.plist", name)]
        require(len(roots) == 1, "Expected exactly one main app")
        info = plistlib.loads(archive.read(roots[0]))
        verify_info(info, build_number)
        app_root = roots[0][:-len("Info.plist")]
        configs = [name for name in names if name.startswith(app_root) and name.endswith("EXConstants.bundle/app.config")]
        require(len(configs) == 1, "Expected one embedded Expo public configuration")
        verify_config(json.loads(archive.read(configs[0])), source_sha)
        extensions = [name for name in names if re.fullmatch(re.escape(app_root) + r"PlugIns/[^/]+\.appex/Info.plist", name)]
        require(len(extensions) == 1, "Expected the Order Share extension")
        verify_info(plistlib.loads(archive.read(extensions[0])), build_number, APP_ID + ".OrderShare")
        with open(path, "rb") as ipa:
            digest = hashlib.file_digest(ipa, "sha256").hexdigest()
        result = {"bundleId": APP_ID, "version": "1.0.1", "buildNumber": build_number, "sourceSha": source_sha,
                  "ipaSha256": digest, "signatureVerified": False}
        if verify_signature:
            with tempfile.TemporaryDirectory(prefix="packproof-ios-verification-") as folder:
                extract_for_signature(archive, folder)
                app = Path(folder) / app_root
                subprocess.run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)], check=True)
                teams = []
                for root, identifier in [(app_root, APP_ID), (extensions[0][:-len("Info.plist")], APP_ID + ".OrderShare")]:
                    bundle = Path(folder) / root
                    profile = plistlib.loads(subprocess.check_output(["security", "cms", "-D", "-i", str(bundle / "embedded.mobileprovision")]))
                    signed = plistlib.loads(subprocess.check_output(["codesign", "-d", "--entitlements", ":-", "--xml", str(bundle)]))
                    teams.append(verify_profile(profile, signed, identifier))
                require(teams[0] == teams[1], "App and extension signing teams differ")
                result.update(signatureVerified=True, signingTeam=teams[0])
        return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-json", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--build-json")
    parser.add_argument("--build-id")
    parser.add_argument("--ipa")
    parser.add_argument("--checksums")
    parser.add_argument("--verify-signature", action="store_true")
    args = parser.parse_args()
    number = verify_run(json.loads(Path(args.run_json).read_text()), args.source_sha, args.run_id, args.repository)
    if not args.build_json:
        print(json.dumps({"archiveRunVerified": True, "buildNumber": number})); return
    require(args.build_id and args.ipa and args.checksums, "Build metadata, IPA, checksums and exact build ID are required")
    verify_build(json.loads(Path(args.build_json).read_text()), args.source_sha, args.build_id, number)
    result = verify_ipa(args.ipa, args.source_sha, number, args.verify_signature)
    expected = [line.split()[0] for line in Path(args.checksums).read_text().splitlines()
                if len(line.split()) == 2 and line.split()[1].lstrip("*") in ["dist/PackProof.ipa", "PackProof.ipa"]]
    require(len(expected) == 1 and expected[0] == result["ipaSha256"], "IPA checksum differs from the signed archive receipt")
    print(json.dumps({**result, "easBuildId": args.build_id, "archiveRunId": args.run_id}, indent=2))


if __name__ == "__main__":
    main()
