#!/usr/bin/env python3
"""Validate release AAB ELF64 compatibility and embedded R8 class mappings.

Prints JSON and exits nonzero on failure. Checks actual native ELF segments,
requires both release ABIs by default, and rejects missing, empty, malformed,
or identity-only R8 class mappings. AAB ZIP offsets are intentionally ignored:
the bundle's PAGE_ALIGNMENT_16K configuration and generated APK alignment must
be checked separately, along with package/version/SDK and signing identity.
"""

import argparse
import importlib.util
import json
import re
import sys
import zipfile
from pathlib import Path

MAPPING_PATH = "BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map"
CLASS_MAPPING = re.compile(r"^([^\s:#]+) -> ([^\s:#]+):(?:\s*)$")
_spec = importlib.util.spec_from_file_location(
    "packproof_page_size", Path(__file__).with_name("check-apk-page-size.py")
)
_native = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_native)


def check_aab(path, required_abis=_native.RELEASE_ABIS):
    result = _native.check_native_archive(Path(path), "aab", required_abis)
    mapping = {"path": MAPPING_PATH, "bytes": 0, "class_count": 0,
               "renamed_class_count": 0, "identity_class_count": 0}
    result["r8_mapping"] = mapping
    try:
        with zipfile.ZipFile(path) as archive:
            try:
                data = archive.read(MAPPING_PATH)
            except KeyError:
                result["errors"].append(f"R8 mapping is missing: {MAPPING_PATH}")
            else:
                mapping["bytes"] = len(data)
                original_names = set()
                for line in data.decode("utf-8-sig").splitlines():
                    if not line.strip() or line.lstrip().startswith("#") or line[0].isspace():
                        continue  # comments and member mappings
                    match = CLASS_MAPPING.fullmatch(line)
                    if not match:
                        raise ValueError("R8 mapping contains an invalid class mapping line")
                    original, renamed = match.groups()
                    if original in original_names:
                        raise ValueError(f"R8 mapping has a duplicate original class: {original}")
                    original_names.add(original)
                    mapping["class_count"] += 1
                    key = "identity_class_count" if original == renamed else "renamed_class_count"
                    mapping[key] += 1
                if not mapping["bytes"]:
                    result["errors"].append("R8 mapping is empty")
                if not mapping["renamed_class_count"]:
                    result["errors"].append("R8 mapping has no renamed classes; release obfuscation is not demonstrated")
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError, NotImplementedError) as error:
        result["errors"].append(f"Cannot inspect R8 mapping: {error}")
    result["passed"] = not result["errors"]
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("aab", type=Path)
    parser.add_argument("--required-abis", nargs="+", choices=_native.RELEASE_ABIS,
                        default=_native.RELEASE_ABIS)
    args = parser.parse_args()
    report = check_aab(args.aab, args.required_abis)
    print(json.dumps(report, separators=(",", ":")))
    sys.exit(0 if report["passed"] else 1)
