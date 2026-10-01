"""Bounded JSON and media contracts; all hashes cover original unmodified bytes."""
from __future__ import annotations
import hashlib
import json
import math
import os
import re
import struct
from pathlib import Path

SCHEMA = "surface-job/1"
GROUPS = {"print", "carton", "context"}
PROCESSES = {"inkjet", "laser", "thermal_transfer", "direct_thermal", "substrate", "unknown"}
MAX_JSON_BYTES = 2 * 1024 * 1024

class InputError(ValueError):
    pass

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()

def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()

def file_digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def read_json(path):
    p = Path(path)
    if p.stat().st_size > MAX_JSON_BYTES:
        raise InputError("JSON exceeds 2 MiB")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise InputError("Duplicate JSON key")
            result[key] = value
        return result
    return json.loads(p.read_bytes(), object_pairs_hook=pairs,
                      parse_constant=lambda x: (_ for _ in ()).throw(InputError("Nonfinite JSON")))

def ident(value, name):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", value):
        raise InputError(f"Invalid {name}")
    return value

def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

def validate_capture(value, profile, name):
    if not isinstance(value, dict):
        raise InputError(f"{name} must be an object")
    bounds = profile["engineeringBounds"]
    sources, regions = value.get("sources", []), value.get("regions", [])
    if not isinstance(sources, list) or not 1 <= len(sources) <= bounds["maxSources"]:
        raise InputError(f"{name} requires 1 to {bounds['maxSources']} sources")
    if not isinstance(regions, list) or len(regions) > bounds["maxRegions"]:
        raise InputError(f"{name} has invalid regions")
    source_ids = set()
    for source in sources:
        if not isinstance(source, dict):
            raise InputError("Source must be an object")
        sid = ident(source.get("sourceId"), "sourceId")
        if sid in source_ids:
            raise InputError("Duplicate sourceId")
        source_ids.add(sid)
        path = source.get("mediaPath")
        if not isinstance(path, str) or not path or len(path) > 1024 or "\x00" in path:
            raise InputError("Invalid mediaPath")
        if not isinstance(source.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", source["sha256"]):
            raise InputError("Invalid source sha256")
        if source.get("frameTimeMs") is not None and (not finite_number(source["frameTimeMs"]) or source["frameTimeMs"] < 0):
            raise InputError("Invalid frameTimeMs")
    region_ids = set()
    for region in regions:
        if not isinstance(region, dict):
            raise InputError("Region must be an object")
        rid = ident(region.get("id"), "region id")
        if rid in region_ids:
            raise InputError("Duplicate region id; use distinct id and shared trackId for repeated frames")
        region_ids.add(rid)
        if region.get("sourceId") not in source_ids or region.get("group") not in GROUPS:
            raise InputError("Unknown region source/group")
        if region.get("process", "unknown") not in PROCESSES:
            raise InputError("Unknown print process")
        polygon = region.get("polygon")
        if not isinstance(polygon, list) or len(polygon) != 4 or any(not isinstance(p, list) or len(p) != 2 or not all(finite_number(v) and 0 <= v <= 8192 for v in p) for p in polygon):
            raise InputError("Region polygon must contain four finite pixel coordinates")
        if region.get("trackId") is not None:
            ident(region["trackId"], "trackId")
    hints = value.get("hints", [])
    if not isinstance(hints, list) or len(hints) > bounds["maxSources"]:
        raise InputError("Too many region hints")
    seen_hints = set()
    for hint in hints:
        if not isinstance(hint, dict) or hint.get("sourceId") not in source_ids or hint["sourceId"] in seen_hints:
            raise InputError("Invalid or duplicated region hint source")
        seen_hints.add(hint["sourceId"])
        if hint.get("association") not in {"bound", "same_frame_expected_barcode", "ambiguous"}:
            raise InputError("Invalid hint association")
        if hint.get("printProcess", "unknown") not in PROCESSES:
            raise InputError("Invalid hint process")
        if hint.get("labelTrackId") is not None:
            ident(hint["labelTrackId"], "labelTrackId")
        for key in ("labelPolygon", "barcodePolygon"):
            polygon = hint.get(key)
            if polygon is not None and (not isinstance(polygon, list) or len(polygon) != 4 or any(not isinstance(p, list) or len(p) != 2 or not all(finite_number(v) and 0 <= v <= 8192 for v in p) for p in polygon)):
                raise InputError("Hint polygons require four finite source-pixel coordinates")
    groups = value.get("requiredGroups", ["print", "carton", "context"])
    if not isinstance(groups, list) or len(set(groups)) != len(groups) or not set(groups).issubset(GROUPS):
        raise InputError("Invalid requiredGroups")
    if value.get("acquisition", "supplemental") not in {"live", "supplemental", "offline"}:
        raise InputError("Invalid acquisition")
    ident(value.get("captureProfileId", "unknown"), "captureProfileId")

def validate_job(job, profile):
    if not isinstance(job, dict) or job.get("schemaVersion") != SCHEMA:
        raise InputError("Unsupported job schema")
    ident(job.get("jobId"), "jobId")
    if job.get("profileId") != profile["id"]:
        raise InputError("Unknown profile")
    if job.get("operation") not in {"extract", "compare"}:
        raise InputError("Unknown operation")
    if job.get("requestedScope", "assembly") not in {"label", "carton", "assembly"}:
        raise InputError("Unknown comparison scope")
    validate_capture(job.get("enrollment"), profile, "enrollment")
    if job["operation"] == "compare":
        validate_capture(job.get("observation"), profile, "observation")

def media_bytes(root, source, bounds):
    # Root is server-managed, read-only, and private to one job. Reject links before read.
    root = Path(root).resolve(strict=True)
    relative = Path(source["mediaPath"])
    if relative.is_absolute() or ".." in relative.parts:
        raise InputError("Media path must be relative within media root")
    path = root
    for part in relative.parts:
        path = path / part
        if path.is_symlink():
            raise InputError("Media symlinks are forbidden")
    if not path.is_file() or not path.resolve().is_relative_to(root):
        raise InputError("Missing or invalid media path")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    with os.fdopen(fd, "rb") as f:
        if os.fstat(f.fileno()).st_size > bounds["maxImageBytes"]:
            raise InputError("Image byte limit exceeded")
        data = f.read(bounds["maxImageBytes"] + 1)
    if len(data) > bounds["maxImageBytes"] or hashlib.sha256(data).hexdigest() != source["sha256"]:
        raise InputError("Original media digest mismatch or byte limit exceeded")
    w, h = image_dimensions(data)
    if min(w, h) < 8 or max(w, h) > bounds["maxImageDimension"] or w * h > bounds["maxImagePixels"]:
        raise InputError("Image pixel/dimension limit exceeded before decoding")
    return data, (w, h)

def image_dimensions(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 33:
        if data[12:16] != b"IHDR" or struct.unpack(">I", data[8:12])[0] != 13:
            raise InputError("Malformed PNG header")
        if data[24] != 8 or data[25] not in (0, 2, 6):
            raise InputError("Only 8-bit grayscale/RGB/RGBA PNG is accepted")
        return struct.unpack(">II", data[16:24])
    if not data.startswith(b"\xff\xd8"):
        raise InputError("Only JPEG and PNG originals are accepted")
    pos = 2
    while pos + 4 <= len(data):
        if data[pos] != 255:
            raise InputError("Malformed JPEG marker")
        while pos < len(data) and data[pos] == 255:
            pos += 1
        if pos >= len(data):
            break
        marker = data[pos]
        pos += 1
        if marker in {0xD9, 0xDA}:
            break
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:
            continue
        if pos + 2 > len(data):
            break
        size = struct.unpack(">H", data[pos:pos + 2])[0]
        if size < 2 or pos + size > len(data):
            raise InputError("Truncated JPEG segment")
        if marker in {0xC0, 0xC1, 0xC2}:
            if size < 8 or data[pos + 2] != 8:
                raise InputError("Only 8-bit JPEG is accepted")
            h, w = struct.unpack(">HH", data[pos + 3:pos + 7])
            return w, h
        pos += size
    raise InputError("Missing JPEG dimensions")
