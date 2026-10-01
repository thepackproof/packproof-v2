#!/usr/bin/env python3
"""Verify a surface-export/1 JSON snapshot offline. Never decode images or contact a network."""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

VERSION = "surface-verifier/1"
MAX_JSON = 32 * 1024 * 1024
MAX_ITEMS = 4096
MAX_MEDIA = 8 * 1024 * 1024


class Invalid(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Invalid(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def is_digest(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def parse(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate JSON member")
            result[key] = value
        return result
    def nonfinite(_):
        raise Invalid("Nonfinite JSON number")
    require(len(raw) <= MAX_JSON, "JSON byte limit exceeded")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=nonfinite)


def read_json(path):
    with open(path, "rb") as stream:
        require(os.fstat(stream.fileno()).st_size <= MAX_JSON, "JSON byte limit exceeded")
        return parse(stream.read(MAX_JSON + 1))


def items(value, name):
    require(isinstance(value, list) and len(value) <= MAX_ITEMS, "Invalid " + name + " inventory")
    return value


def sealed(row, label):
    require(isinstance(row, dict) and isinstance(row.get("canonicalJson"), str), label + " lacks exact bytes")
    raw = row["canonicalJson"].encode("utf-8")
    require(is_digest(row.get("sha256")) and sha(raw) == row["sha256"], label + " digest mismatch")
    value = parse(raw)
    require(isinstance(value, dict), label + " payload must be an object")
    return value


def safe_media(root, relative, expected, size):
    require(isinstance(relative, str) and len(relative) <= 1024 and
            re.fullmatch(r"[A-Za-z0-9_./-]+", relative) is not None, "Invalid media path")
    require(not relative.startswith("/") and all(part not in ("", ".", "..") for part in relative.split("/")),
            "Media path must be relative and contained")
    require(type(size) is int and 0 < size <= MAX_MEDIA, "Invalid source byte size")
    base = Path(root).resolve(strict=True)
    path = base
    for part in relative.split("/"):
        path = path / part
        require(not path.is_symlink(), "Media symlinks are forbidden")
    require(path.resolve(strict=True).is_relative_to(base), "Media escapes media directory")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_size == size, "Media type or length differs")
        raw = stream.read(MAX_MEDIA + 1)
    require(len(raw) == size and sha(raw) == expected, "Source media digest mismatch")


def signature_checker(trust_path):
    # Reuse the existing independently supplied trust-list verification implementation.
    if not trust_path:
        return lambda raw, signature: {"status": "UNSIGNED" if signature is None else "UNTRUSTED_KEY", "verified": False}
    spec = importlib.util.spec_from_file_location("packproof_root_verifier", Path(__file__).with_name("verify.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        keys, trust = module.load_trust(trust_path, module.dt.datetime.now(module.dt.timezone.utc))
    except module.VerificationError as error:
        raise Invalid("Invalid independently supplied trust list: " + str(error)) from error
    require(trust["status"] == "FRESH", "Independently supplied trust list is not fresh")
    return lambda raw, signature: module.check_signature(raw, signature, keys)


def verify(document, *, expected_root=None, expected_head=None, expected_proof=None, expected_tenant=None, media_dir=None, trust_list=None, private_artifacts=None):
    require(isinstance(document, dict) and document.get("schemaVersion") == "surface-export/1", "Unsupported export schema")
    proof = document.get("proofId")
    require(isinstance(proof, str) and 0 < len(proof) <= 160, "Invalid Proof identity")
    require(expected_proof is None or expected_proof == proof, "Unexpected Proof identity")
    require(expected_root is None or is_digest(expected_root), "Invalid pinned root digest")
    require(expected_head is None or is_digest(expected_head), "Invalid pinned extension head")
    root = document.get("root")
    root_digest = None
    if root is not None:
        root_value = sealed(root, "Root")
        require(root_value.get("proofId") == proof, "Root Proof identity differs")
        root_digest = root["sha256"]
    require(expected_root is None or root_digest == expected_root, "Frozen root differs from independently pinned digest")

    sources = {}
    checked_sources = 0
    omissions = []
    for row in items(document.get("sources"), "sources"):
        require(isinstance(row, dict) and isinstance(row.get("sourceId"), str) and row["sourceId"] not in sources,
                "Duplicate or malformed source")
        require(is_digest(row.get("sha256")), "Invalid source digest")
        require(type(row.get("byteSize")) is int and 0 < row["byteSize"] <= MAX_MEDIA, "Invalid source byte size")
        require(row.get("availability") in {"available", "expired", "not_checked"}, "Invalid source availability")
        sources[row["sourceId"]] = row
        if row.get("mediaPath") is not None and media_dir is not None:
            require(row["availability"] != "expired", "Expired source cannot claim present original bytes")
            safe_media(media_dir, row["mediaPath"], row["sha256"], row["byteSize"])
            checked_sources += 1
        else:
            omissions.append({"sourceId": row["sourceId"], "reason": row["availability"] if row["availability"] != "available" else "ORIGINAL_BYTES_NOT_SUPPLIED"})

    records, record_values = {}, {}
    referenced_sources = set()
    for row in items(document.get("records"), "records"):
        require(isinstance(row, dict) and isinstance(row.get("id"), str) and row["id"] not in records,
                "Duplicate or malformed record")
        value = sealed(row, "Record")
        require(row.get("kind") in {"enrollment", "observation", "comparison"}, "Invalid record kind")
        require(value.get("proofId") == proof, "Record Proof identity differs")
        require(expected_tenant is None or value.get("tenantScope") == expected_tenant, "Record tenant identity differs")
        require(value.get("kind") == row["kind"], "Record kind differs")
        require(value.get("id", value.get("recordId")) == row["id"], "Record ID differs")
        for source in [*value.get("sources", []), *value.get("sourceDigests", [])]:
            exported = sources.get(source.get("sourceId"))
            require(exported is not None and source.get("sha256") == exported["sha256"], "Record source commitment differs")
            referenced_sources.add(source["sourceId"])
            if "byteSize" in source:
                require(source["byteSize"] == exported["byteSize"], "Record source length differs")
            for field in ("objectVersionId", "contentType"):
                if field in source:
                    require(source[field] == exported.get(field), "Record immutable source metadata differs")
        records[row["id"]], record_values[row["id"]] = row, value
    for identity, value in record_values.items():
        for name in ("enrollment", "observation"):
            reference = value.get(name + "Id")
            if reference is not None:
                require(reference in records and records[reference]["kind"] == name, "Missing or mistyped bound " + name)
                require(value.get(name + "Sha256") == records[reference]["sha256"], "Bound " + name + " digest differs")
        supersedes = value.get("supersedesComparisonId")
        if supersedes is not None:
            require(supersedes in records and records[supersedes]["kind"] == "comparison" and supersedes != identity,
                    "Invalid superseded comparison")
            prior = record_values[supersedes]
            require(prior.get("enrollmentId") == value.get("enrollmentId") and prior.get("observationId") == value.get("observationId"),
                    "Superseded comparison source binding differs")

    templates = {}
    artifact_rows = []
    for artifact in items(private_artifacts or [], "private artifacts"):
        require(isinstance(artifact, dict) and artifact.get("schemaVersion") == "surface-result/1", "Invalid private artifact schema")
        payload = sealed({"canonicalJson": artifact.get("artifactCanonicalJson"), "sha256": artifact.get("artifactSha256")}, "Private result artifact")
        require(payload.get("schemaVersion") == "surface-result/1" and payload.get("jobId") == artifact.get("jobId"), "Private artifact identity differs")
        artifact_rows.append((artifact["artifactSha256"], payload))
        for role, template in payload.get("templates", {}).items():
            require(role in {"enrollment", "observation"}, "Unexpected private template role")
            if template is not None:
                row = {"id": template.get("artifactSha256"), "canonicalJson": template.get("canonicalJson"), "sha256": template.get("artifactSha256")}
                sealed(row, "Private template")
                templates[row["id"]] = row
    for row in items(document.get("templates", []), "templates"):
        value = sealed(row, "Template")
        require(isinstance(row.get("id"), str) and row["id"] not in templates, "Duplicate or malformed template")
        templates[row["id"]] = row

    analyses, analysis_values = {}, {}
    template_commitments = set()
    artifact_commitments = {}
    check_signature = signature_checker(trust_list)
    signatures = []
    for row in items(document.get("analyses"), "analyses"):
        require(isinstance(row, dict) and isinstance(row.get("id"), str) and row["id"] not in analyses,
                "Duplicate or malformed analysis")
        value = sealed(row, "Analysis")
        require(value.get("proofId") == proof, "Analysis Proof identity differs")
        require(value.get("id") == row["id"], "Analysis ID differs")
        require(value.get("recordId") in records and value.get("sourceRecordSha256") == records[value["recordId"]]["sha256"],
                "Analysis source record differs")
        result = value.get("result", {})
        require(isinstance(result, dict), "Analysis result must be an object")
        if result.get("artifactSha256") is not None:
            require(is_digest(result["artifactSha256"]), "Invalid result artifact commitment")
            artifact_commitments[result["artifactSha256"]] = value.get("jobId")
        for source in [*value.get("sourceDigests", []), *result.get("sourceDigests", [])]:
            if isinstance(source, str):
                require(source in {item["sha256"] for item in sources.values()}, "Analysis source digest absent")
            else:
                require(isinstance(source, dict) and source.get("sourceId") in sources and source.get("sha256") == sources[source["sourceId"]]["sha256"], "Analysis source differs")
        for template in value.get("templateDigests", []):
            require(is_digest(template), "Invalid template commitment")
            template_commitments.add(template)
        role_templates = result.get("templateDigests", {})
        require(isinstance(role_templates, dict) and set(role_templates).issubset({"enrollment", "observation"}), "Invalid result template commitments")
        for template in role_templates.values():
            require(template is None or is_digest(template), "Invalid result template digest")
            if template is not None:
                template_commitments.add(template)
        signature = check_signature(row["canonicalJson"].encode(), row.get("signature"))
        require(signature["status"] not in {"INVALID_SIGNATURE", "REVOKED_KEY"}, "Analysis signature invalid")
        signatures.append(signature)
        analyses[row["id"]], analysis_values[row["id"]] = row, value

    supplied_template_digests = {row["sha256"] for row in templates.values()}
    require(supplied_template_digests.issubset(template_commitments), "Supplied template is absent from analysis commitments")
    missing_templates = sorted(template_commitments - supplied_template_digests)
    for artifact_digest, payload in artifact_rows:
        require(artifact_digest in artifact_commitments and artifact_commitments[artifact_digest] == payload.get("jobId"),
                "Private result artifact differs from committed analysis")

    previous = None
    covered = set()
    extension_signatures = []
    extensions = items(document.get("extensions"), "extensions")
    for sequence, row in enumerate(extensions, 1):
        value = sealed(row, "Extension")
        require(value.get("schemaVersion") == "surface-extension/1" and value.get("id") == row.get("id"), "Extension schema/ID differs")
        require(type(row.get("sequence")) is int and row["sequence"] == sequence, "Extension sequence gap/reordering")
        require(value.get("sequence") == sequence and value.get("proofId") == proof, "Extension scope differs")
        require(row.get("previousSha256") == previous and value.get("previousSha256") == previous, "Extension ancestry differs")
        require(row.get("rootManifestSha256") in (None, root_digest) and value.get("rootManifestSha256") == row.get("rootManifestSha256"), "Extension frozen root differs")
        subject_id = value.get("subjectId")
        kind = value.get("kind")
        if kind == "source":
            subject = sources.get(subject_id)
            subject_digest = value.get("sourceSha256")
            require(value.get("sourceId") == subject_id, "Source extension ID differs")
            require(subject is not None and value.get("byteSize") == subject["byteSize"], "Source extension size differs")
            if "contentType" in value:
                require(value["contentType"] == subject.get("contentType"), "Source extension content type differs")
            referenced_sources.add(subject_id)
        elif kind in {"enrollment", "observation", "comparison"}:
            subject = records.get(subject_id)
            subject_digest = value.get("recordSha256")
            require(value.get("recordId") == subject_id and subject is not None and subject["kind"] == kind, "Record extension kind/ID differs")
        elif kind == "analysis":
            subject = analyses.get(subject_id)
            subject_digest = value.get("analysisSha256")
            require(value.get("analysisId", subject_id) == subject_id, "Analysis extension ID differs")
            if "recordId" in value:
                require(value["recordId"] in records and value.get("recordSha256") == records[value["recordId"]]["sha256"], "Analysis extension record differs")
        else:
            raise Invalid("Unknown extension kind")
        require(subject is not None and subject_digest == subject["sha256"], "Extension subject commitment differs")
        require(subject_id not in covered, "Duplicate extension subject")
        covered.add(subject_id)
        signature = check_signature(row["canonicalJson"].encode(), row.get("signature"))
        require(signature["status"] not in {"INVALID_SIGNATURE", "REVOKED_KEY"}, "Extension signature invalid")
        signatures.append(signature)
        extension_signatures.append(signature)
        previous = row["sha256"]
    require((set(records) | set(analyses)).issubset(covered), "Record or analysis is missing its extension commitment")
    require(referenced_sources == set(sources), "Source inventory includes an uncommitted extra source")
    require(expected_head is None or expected_head == previous, "Extension head differs from independently pinned digest")
    all_signed = bool(extensions) and all(item["verified"] for item in extension_signatures)
    return {
        "verifierVersion": VERSION, "status": "INTEGRITY_CHECKED" if expected_root or expected_head or all_signed else "SELF_CONSISTENT_UNTRUSTED",
        "proofId": proof, "rootSha256": root_digest, "rootUnchangedAgainstIndependentDigest": expected_root is not None,
        "extensionHeadSha256": previous, "extensionHeadMatchedIndependentDigest": expected_head is not None,
        "extensionAuthentication": "VERIFIED_SIGNATURES" if all_signed else "PINNED_HEAD" if expected_head else "SELF_CONSISTENCY_ONLY",
        "recordsChecked": len(records), "analysesChecked": len(analyses), "templatesChecked": len(templates),
        "templateCommitmentsChecked": len(template_commitments), "omittedTemplateDigests": missing_templates,
        "privateResultArtifactsChecked": len(artifact_rows),
        "sourceCommitmentsChecked": len(sources), "originalsChecked": checked_sources, "omissions": omissions,
        "completeOriginals": bool(sources) and not omissions, "signatures": signatures,
        "allExtensionSignaturesVerified": bool(extensions) and all_signed,
        "physicalAccuracy": "NOT_EVALUATED", "sourceAcquisitionAssurance": "NOT_VERIFIED",
        "snapshotCompleteness": "PINNED_HEAD_MATCHED" if expected_head else "LATER_OR_TRUNCATED_SNAPSHOT_NOT_EXCLUDED",
        "limitations": ["Digests establish exact bytes, not physical identity, scene truth, contents, closure or custody.",
                        "A supplied root/head digest is trustworthy only if obtained independently of this export.",
                        "Private template/source omissions prevent full independent matcher replay.",
                        "No image was decoded and no network connection was made."]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export")
    parser.add_argument("--expected-root-sha256")
    parser.add_argument("--expected-extension-head-sha256")
    parser.add_argument("--expected-proof-id")
    parser.add_argument("--expected-tenant-id", help="Required tenantScope identity, including account: prefix for personal Proofs")
    parser.add_argument("--media-dir", help="Read original media from this separately supplied directory; paths are constrained")
    parser.add_argument("--trust-list", help="Separately authenticated trust-list, never an export-included key")
    parser.add_argument("--private-artifact", action="append", default=[], help="Authorized private worker result JSON; may be repeated; never published by this tool")
    args = parser.parse_args(argv)
    try:
        result = verify(read_json(args.export), expected_root=args.expected_root_sha256,
                        expected_head=args.expected_extension_head_sha256, expected_proof=args.expected_proof_id,
                        expected_tenant=args.expected_tenant_id,
                        media_dir=args.media_dir, trust_list=args.trust_list,
                        private_artifacts=[read_json(path) for path in args.private_artifact])
        code = 0 if result["status"] == "INTEGRITY_CHECKED" else 2
    except (ValueError, OSError, TypeError, KeyError, AttributeError, RecursionError, UnicodeError) as error:
        result = {"verifierVersion": VERSION, "status": "INVALID_EXPORT", "message": str(error)}
        code = 1
    print(json.dumps(result, indent=2, ensure_ascii=True))
    return code


if __name__ == "__main__":
    sys.exit(main())
