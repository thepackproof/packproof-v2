#!/usr/bin/env python3
"""Stage both Connect images privately. Run again with the same packet and state directory to resume."""
import argparse
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

ACCOUNT = "784514617543"
REGION = "us-east-1"
PROJECT = "packproof-v2-staging-api"
PROFILES = ("collector-hosted-bridge", "reconstruction-v11")
FAILED = {"FAILED", "FAULT", "STOPPED", "TIMED_OUT"}
CLI = Path(__file__).with_name("stage-image.mjs")


def node_json(*args):
    return json.loads(subprocess.check_output(["node", str(CLI), *map(str, args)], text=True))


def save(path, data):
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf8") as out:
        tmp = Path(out.name)
        try:
            json.dump(data, out, indent=2)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
    try:
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


@contextmanager
def state_lock(directory):
    lock = (directory / ".operator.lock").open("a+b")
    try:
        try:
            if os.name == "nt":
                import msvcrt
                if not lock.seek(0, os.SEEK_END):
                    lock.write(b"1")
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError("Another operator process is using this state directory.") from exc
        yield
    finally:
        lock.close()


def refresh(s3, keys):
    target = {"Bucket": keys["bucket"], "Key": keys["archiveKey"], "IfNoneMatch": "*",
              "ServerSideEncryption": "AES256"}
    url = s3.generate_presigned_url("put_object", Params=target, ExpiresIn=900, HttpMethod="PUT")
    s3.put_object(Bucket=keys["bucket"], Key=keys["descriptorKey"], ExpectedBucketOwner=ACCOUNT,
                  Body=json.dumps({"url": url}).encode(), ContentType="application/json",
                  CacheControl="no-store", ServerSideEncryption="AES256")
    return int(time.time())


def matches(build, request):
    source = build.get("source", {})
    return (build.get("projectName") == PROJECT and source.get("type") == "NO_SOURCE" and
            source.get("buildspec") == request["buildspecOverride"])


def recover_build(cb, request, attempted):
    # A response may be lost between StartBuild and the local atomic write. The
    # post-build command embeds this run nonce. Check provider history first.
    # AWS defaults to newest first. An explicit sort order is rejected on
    # projects with more than 100 historical builds.
    pages = cb.get_paginator("list_builds_for_project").paginate(projectName=PROJECT)
    for page in pages:
        ids = page.get("ids", [])
        if not ids:
            continue
        builds = cb.batch_get_builds(ids=ids)["builds"]
        found = [b["id"] for b in builds if matches(b, request)]
        if len(found) > 1:
            raise RuntimeError("Multiple CodeBuild jobs match this staging request.")
        if found:
            return found[0]
        if builds and all(b.get("startTime") and b["startTime"].timestamp() < attempted - 300 for b in builds):
            break
    if time.time() - attempted >= 270:
        raise RuntimeError("Ambiguous StartBuild has no matching job in provider history. Inspect the project before creating another run.")
    return None  # Same token is still in CodeBuild's documented five-minute idempotency window.


def verified_receipt(build, logs, s3, keys, source, profile):
    log = build.get("logs", {})
    if not log.get("groupName") or not log.get("streamName"):
        return None
    receipt = None
    for page in logs.get_paginator("filter_log_events").paginate(
            logGroupName=log["groupName"], logStreamNames=[log["streamName"]],
            filterPattern='"packproof.staged-connect-image/v1"'):
        for event in page.get("events", []):
            message = event["message"]
            pos = message.find('{"schema":"packproof.staged-connect-image/v1"')
            if pos < 0:
                continue
            item = json.loads(message[pos:].strip())
            if receipt is not None and item != receipt:
                raise RuntimeError("Multiple conflicting staging receipts in CodeBuild.")
            receipt = item
    if receipt is None:
        return None
    expected = {"schema": "packproof.staged-connect-image/v1", "source": source, "profile": profile,
                "bucket": keys["bucket"], "archiveKey": keys["archiveKey"]}
    size = receipt.get("bytes")
    if (any(receipt.get(k) != v for k, v in expected.items()) or type(size) is not int or
            not 0 < size <= 5 * 1024**3 or not re.fullmatch("[a-f0-9]{64}", str(receipt.get("sha256")))):
        raise RuntimeError("Build receipt does not identify this exact staging request.")
    obj = s3.get_object(Bucket=keys["bucket"], Key=keys["archiveKey"], ExpectedBucketOwner=ACCOUNT)
    h = hashlib.sha256()
    length = 0
    try:
        if obj["ContentLength"] != size or obj.get("ServerSideEncryption") != "AES256":
            raise RuntimeError("Staged archive size or encryption differs from the verified build.")
        for chunk in obj["Body"].iter_chunks(chunk_size=4*1024*1024):
            length += len(chunk)
            h.update(chunk)
    finally:
        obj["Body"].close()
    if length != size or h.hexdigest() != receipt["sha256"]:
        raise RuntimeError("Downloaded staging bytes differ from the build receipt.")
    return {**expected, "sha256": h.hexdigest(), "bytes": length}


def stage(packet, directory, source, retry, s3, cb, logs):
    checkpoint = directory / "state.json"
    fresh = lambda: {"nonce": secrets.token_hex(16)}
    if checkpoint.exists():
        state = json.loads(checkpoint.read_text(encoding="utf8"))
        if state.get("schema") != "packproof.private-image-stage/v1" or state.get("source") != source:
            raise RuntimeError("State directory belongs to another release.")
    else:
        state = {"schema": "packproof.private-image-stage/v1", "source": source,
                 "profiles": {p: fresh() for p in PROFILES}}
        save(checkpoint, state)
    context = {}
    for profile in PROFILES:
        entry = state["profiles"][profile]
        if retry and entry.get("status") in FAILED:
            state["profiles"][profile] = entry = fresh()
            save(checkpoint, state)
        nonce = entry["nonce"]
        keys = node_json("keys", source, profile, nonce)
        request = node_json("request", packet, source, profile, nonce)
        fingerprint = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
        if entry.get("requestSha256", fingerprint) != fingerprint:
            raise RuntimeError("The packet build request changed after staging began.")
        entry["requestSha256"] = fingerprint
        context[profile] = (keys, request)
        if entry.get("buildId"):
            continue
        if entry.get("attempted"):
            prior = recover_build(cb, request, entry["attempted"])
            if prior:
                entry["buildId"] = prior
                save(checkpoint, state)
                continue
        entry["refreshed"] = refresh(s3, keys)
        entry.setdefault("attempted", int(time.time()))
        save(checkpoint, state)
        entry["buildId"] = cb.start_build(**request)["build"]["id"]
        save(checkpoint, state)
        print(profile, entry["buildId"], flush=True)

    while True:
        ids = [e["buildId"] for e in state["profiles"].values()]
        builds = {b["id"]: b for b in cb.batch_get_builds(ids=ids)["builds"]}
        waiting = False
        errors = []
        for profile in PROFILES:
            entry = state["profiles"][profile]
            build = builds.get(entry["buildId"])
            keys, request = context[profile]
            if not build or not matches(build, request):
                raise RuntimeError("Stored build ID does not match this release request.")
            status = build["buildStatus"]
            if entry.get("status") != status:
                print(profile, status, flush=True)
            entry["status"] = status
            if status in FAILED:
                errors.append(profile + " " + status)
            elif status == "SUCCEEDED":
                output = directory / (profile + ".json")
                if output.exists() and "receipt" in entry:
                    if json.loads(output.read_text(encoding="utf8")) != entry["receipt"]:
                        raise RuntimeError("Saved receipt has changed. Remove the receipt file and resume to verify it again.")
                    continue
                receipt = verified_receipt(build, logs, s3, keys, source, profile)
                if receipt:
                    save(output, receipt)
                    entry["receipt"] = receipt
                    print(profile, receipt["sha256"], str(output), flush=True)
                elif time.time() - build["endTime"].timestamp() > 300:
                    errors.append(profile + " has no verified receipt in its build log")
                else:
                    waiting = True
            else:
                waiting = True
                if time.time() - entry.get("refreshed", 0) >= 600:
                    entry["refreshed"] = refresh(s3, keys)
        save(checkpoint, state)
        if not waiting:
            if errors:
                raise RuntimeError(", ".join(errors) + ". Use --retry-failed to restart failed builds.")
            return
        time.sleep(20)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packet", type=Path)
    parser.add_argument("state_directory", type=Path)
    parser.add_argument("--aws-profile")
    parser.add_argument("--retry-failed", action="store_true")
    args = parser.parse_args()
    import boto3
    from botocore.config import Config

    source = json.loads((args.packet / "rollout.json").read_text(encoding="utf8"))["source"]
    directory = args.state_directory.resolve()
    if directory.is_relative_to(args.packet.resolve()):
        raise RuntimeError("Keep staging state outside the verified release packet.")
    directory.mkdir(parents=True, exist_ok=True)
    cfg = Config(signature_version="s3v4", request_checksum_calculation="when_required",
                 s3={"us_east_1_regional_endpoint": "regional", "addressing_style": "virtual"})
    session = boto3.Session(region_name=REGION, profile_name=args.aws_profile)
    if session.client("sts").get_caller_identity()["Account"] != ACCOUNT:
        raise RuntimeError("AWS profile does not target the reviewed PackProof account.")
    with state_lock(directory):
        stage(args.packet.resolve(), directory, source, args.retry_failed,
              session.client("s3", config=cfg), session.client("codebuild"), session.client("logs"))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("Staging interrupted. Run again with the same state directory to resume.")
    except ImportError as err:
        sys.exit("Install boto3 with a current botocore before running this operator command: " + str(err))
    except Exception as err:
        if hasattr(err, "response"):
            sys.exit("AWS operation failed: " + str(err.response.get("Error", {}).get("Code", "unknown")))
        sys.exit(str(err))
