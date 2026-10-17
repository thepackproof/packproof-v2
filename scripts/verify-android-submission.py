#!/usr/bin/env python3
"""Verify the exact signed Android artifact selected for Play submission."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

REPOSITORY = "thepackproof/packproof-v2"
APP_ID = "com.packproof.mobile"
PROJECT_ID = "0196c3f7-cb3a-472c-99be-825558f227e8"
API_URL = "https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws"
UPLOAD_CERTIFICATE = "75:25:B4:FC:9A:9D:03:4A:E2:94:92:2A:D4:3D:B1:84:43:D0:E1:4D"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_selection(selection):
    for key, pattern in [("sourceSha", r"[a-f0-9]{40}"), ("aabSha256", r"[a-f0-9]{64}"),
                         ("easBuildId", r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")]:
        require(bool(re.fullmatch(pattern, str(selection.get(key, "")))), f"Invalid {key}")
    require(type(selection.get("archiveRunId")) is int and selection["archiveRunId"] > 0, "Invalid archive run")
    require(selection.get("version") == "1.0.1" and type(selection.get("versionCode")) is int and selection.get("versionCode") in (68, 69, 70), "Only the authorized Android 68, 69 and 70 releases are supported")
    require(selection.get("package") == APP_ID, "Wrong Android package")
    require(selection.get("track") == "production" and selection.get("releaseStatus") == "completed", "Wrong Play destination")
    require(selection.get("changesNotSentForReview") is False, "Release must be sent for Play review")


def verify_run(run, selection):
    verify_selection(selection)
    require(run.get("id") == selection["archiveRunId"], "Archive run differs from selection")
    require(run.get("repository", {}).get("full_name") == REPOSITORY, "Wrong archive repository")
    require(run.get("path") == ".github/workflows/android-aab.yml", "Wrong archive workflow")
    require(run.get("event") in ["push", "workflow_dispatch"] and run.get("head_branch") == "main", "Archive must originate from main")
    require(run.get("head_sha") == selection["sourceSha"], "Archive source differs from selection")
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "Archive workflow did not succeed")


def verify_build(value, selection):
    require(not isinstance(value, list) or len(value) == 1, "Expected exactly one EAS build")
    build = value[0] if isinstance(value, list) else value
    for key, expected in {
        "id": selection["easBuildId"], "gitCommitHash": selection["sourceSha"],
        "status": "FINISHED", "platform": "ANDROID", "distribution": "STORE", "buildProfile": "production",
        "appIdentifier": APP_ID, "appVersion": selection["version"],
    }.items():
        require(build.get(key) == expected, f"Unexpected EAS {key}")
    require(str(build.get("appBuildVersion")) == str(selection["versionCode"]), "Wrong EAS version code")
    # EAS CLI 24.4.2 omits project from its build JSON. The signed bundle's
    # embedded project ID is mandatory below; reject contradictory metadata.
    if build.get("project") is not None:
        require(build["project"].get("id") == PROJECT_ID, "Wrong EAS project")


def verify_config(config, selection):
    require(config.get("version") == selection["version"], "Wrong embedded version")
    require(config.get("android", {}).get("package") == APP_ID, "Wrong embedded package")
    require(config.get("android", {}).get("versionCode") == selection["versionCode"], "Wrong embedded version code")
    require(config["android"].get("allowBackup") is False and config["android"].get("usesCleartextTraffic") is False, "Android release security flags are not set")
    extra = config.get("extra", {})
    for key, expected in {
        "packproofBuildSha": selection["sourceSha"], "packproofApiBaseUrl": API_URL,
        "packproofMobileTaskUx": True, "packproofFirstProofExperience": True,
        "packproofResearch": False, "packproofResearchProduction": True,
        "packproofResearchProfile": "capture-receipts-v1",
    }.items():
        require(extra.get(key) == expected and type(extra.get(key)) is type(expected), f"Unexpected embedded {key}")
    if selection["versionCode"] == 70:
        require(extra.get("packproofExperienceRestoration") is True, "Android 70 must enable the approved restoration")
    require(extra.get("packproofInternalReview") is not True, "Internal review build cannot be published")
    require(extra.get("eas", {}).get("projectId") == PROJECT_ID, "Wrong embedded EAS project")


def verify_bundle(path, checksums, selection):
    with open(path, "rb") as bundle:
        digest = hashlib.file_digest(bundle, "sha256").hexdigest()
    require(digest == selection["aabSha256"], "AAB differs from selected checksum")
    expected_name = f"packproof-{selection['version']}-{selection['versionCode']}.aab"
    matches = [line.split()[0] for line in checksums.splitlines() if len(line.split()) == 2
               and line.split()[1].lstrip("*") in [expected_name, "dist/" + expected_name]]
    require(matches == [digest], "AAB differs from build workflow checksum")
    with zipfile.ZipFile(path) as archive:
        configs = [entry for entry in archive.infolist() if entry.filename == "base/assets/app.config"]
        require(len(configs) == 1 and configs[0].file_size < 100_000, "Expected one bounded embedded app config")
        verify_config(json.loads(archive.read(configs[0])), selection)
    return digest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--selection", required=True)
    parser.add_argument("--run-json", required=True)
    parser.add_argument("--build-json")
    parser.add_argument("--aab")
    parser.add_argument("--checksums")
    args = parser.parse_args()
    selection = json.loads(Path(args.selection).read_text())
    verify_run(json.loads(Path(args.run_json).read_text()), selection)
    if not args.build_json:
        print(json.dumps({"archiveRunVerified": True})); return
    require(args.aab and args.checksums, "AAB and checksums are required")
    verify_build(json.loads(Path(args.build_json).read_text()), selection)
    digest = verify_bundle(args.aab, Path(args.checksums).read_text(), selection)
    subprocess.run(["jarsigner", "-verify", args.aab], check=True, stdout=subprocess.DEVNULL)
    certificate = subprocess.check_output(["keytool", "-printcert", "-jarfile", args.aab], text=True)
    require("SHA1: " + UPLOAD_CERTIFICATE in certificate, "Unexpected Android upload certificate")
    print(json.dumps({**selection, "aabSha256": digest, "signatureVerified": True, "submitted": False}, indent=2))


if __name__ == "__main__":
    main()
