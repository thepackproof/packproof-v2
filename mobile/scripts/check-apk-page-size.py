#!/usr/bin/env python3
"""Inspect final APK native libraries for Android 16 KB page compatibility.

Usage: python3 scripts/check-apk-page-size.py path/to/release.apk
Checks ELF LOAD/RELRO segments and uncompressed ZIP payload alignment. This
does not replace signature verification or a launch test on a 16 KB device.
"""

import argparse
import json
import struct
import sys
import zipfile
from pathlib import Path

PAGE = 16384
ABIS = {"arm64-v8a", "x86_64"}


def check_apk(path):
    libraries = []
    errors = []
    with path.open("rb") as raw, zipfile.ZipFile(path) as apk:
        bad_entry = apk.testzip()
        if bad_entry:
            errors.append(f"ZIP CRC failure: {bad_entry}")
        for entry in apk.infolist():
            parts = entry.filename.split("/")
            if len(parts) != 3 or parts[0] != "lib" or not parts[2].endswith(".so"):
                continue
            raw.seek(entry.header_offset)
            header = raw.read(30)
            if header[:4] != b"PK\x03\x04":
                raise ValueError(f"Invalid ZIP local header: {entry.filename}")
            name_size, extra_size = struct.unpack_from("<HH", header, 26)
            payload_offset = entry.header_offset + 30 + name_size + extra_size
            compressed = entry.compress_type != zipfile.ZIP_STORED
            if not compressed and payload_offset % PAGE:
                errors.append(f"{entry.filename}: uncompressed ZIP payload is not 16 KB aligned")
            if parts[1] not in ABIS:
                continue
            data = apk.read(entry)
            if data[:6] != b"\x7fELF\x02\x01":
                raise ValueError(f"Expected little-endian ELF64: {entry.filename}")
            phoff = struct.unpack_from("<Q", data, 32)[0]
            phsize, phnum = struct.unpack_from("<HH", data, 54)
            if phsize < 56 or phoff + phsize * phnum > len(data):
                raise ValueError(f"Invalid ELF program headers: {entry.filename}")
            loads = []
            relro_ends = []
            for i in range(phnum):
                kind, _, offset, vaddr, _, _, memsz, alignment = struct.unpack_from(
                    "<IIQQQQQQ", data, phoff + i * phsize
                )
                if kind == 1:  # PT_LOAD
                    loads.append(alignment)
                    if alignment < PAGE or alignment & (alignment - 1) or (vaddr - offset) % PAGE:
                        errors.append(f"{entry.filename}: LOAD segment is not 16 KB compatible")
                elif kind == 0x6474E552:  # PT_GNU_RELRO
                    relro_ends.append(vaddr + memsz)
                    if (vaddr + memsz) % PAGE:
                        errors.append(f"{entry.filename}: GNU_RELRO end is not 16 KB aligned")
            if not loads:
                errors.append(f"{entry.filename}: no LOAD segments")
            libraries.append({
                "path": entry.filename,
                "load_alignments": loads,
                "relro_ends": relro_ends,
                "zip_compressed": compressed,
                "zip_payload_offset": payload_offset,
            })
    if not libraries:
        errors.append("No 64-bit native libraries found; cannot verify this native APK")
    return {"apk": str(path), "page_size": PAGE, "libraries_checked": len(libraries),
            "passed": not errors, "errors": errors, "libraries": libraries}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    args = parser.parse_args()
    report = check_apk(args.apk)
    print(json.dumps(report, indent=2))
    sys.exit(0 if report["passed"] else 1)
