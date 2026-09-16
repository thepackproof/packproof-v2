#!/usr/bin/env python3
"""Check a final APK's ELF64 LOAD segments and uncompressed ZIP alignment.

Prints JSON and exits nonzero on failure. Both release ABIs are required by
default; use --required-abis arm64-v8a for an intentional device-specific APK.
32-bit alignment is reported, but does not determine 16 KB compatibility.
This static check does not replace signature verification or a 16 KB device test.

The AAB validator imports this module to share the ELF inspection rules.
"""

import argparse
import hashlib
import json
import struct
import sys
import zipfile
from pathlib import Path

PAGE_SIZE = 16384
RELEASE_ABIS = ("arm64-v8a", "x86_64")
ABI_ELF = {"arm64-v8a": (64, 183), "x86_64": (64, 62),
           "armeabi-v7a": (32, 40), "x86": (32, 3)}


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_elf(data):
    """Read ELF headers directly, without depending on a host readelf tool."""
    if len(data) < 16 or data[:4] != b"\x7fELF":
        raise ValueError("not an ELF library")
    elf_class, encoding, version = data[4:7]
    if elf_class not in (1, 2) or encoding not in (1, 2) or version != 1:
        raise ValueError("invalid ELF identification")
    endian = "<" if encoding == 1 else ">"
    bits = 64 if elf_class == 2 else 32
    header_size, program_size = (64, 56) if bits == 64 else (52, 32)
    if len(data) < header_size:
        raise ValueError("truncated ELF header")
    elf_type, machine = struct.unpack_from(endian + "HH", data, 16)
    if elf_type != 3:  # ET_DYN
        raise ValueError("native library is not ET_DYN")
    if bits == 64:
        phoff = struct.unpack_from(endian + "Q", data, 32)[0]
        phsize, phnum = struct.unpack_from(endian + "HH", data, 54)
    else:
        phoff = struct.unpack_from(endian + "I", data, 28)[0]
        phsize, phnum = struct.unpack_from(endian + "HH", data, 42)
    if (phoff < header_size or phsize < program_size or phnum in (0, 65535)
            or phoff + phsize * phnum > len(data)):
        raise ValueError("invalid or unsupported ELF program header table")

    loads = []
    for index in range(phnum):
        header = struct.unpack_from(
            endian + ("IIQQQQQQ" if bits == 64 else "IIIIIIII"),
            data, phoff + index * phsize,
        )
        if header[0] != 1:  # PT_LOAD
            continue
        if bits == 64:
            _, _, offset, vaddr, _, filesz, memsz, alignment = header
        else:
            _, offset, vaddr, _, filesz, memsz, _, alignment = header
        if filesz > memsz or offset + filesz > len(data):
            raise ValueError(f"LOAD {index} extends beyond its file or memory range")
        power_of_two = alignment > 0 and not (alignment & (alignment - 1))
        congruent = (vaddr - offset) % PAGE_SIZE == 0
        compatible = (alignment >= PAGE_SIZE and power_of_two and congruent
                      and (vaddr - offset) % alignment == 0)
        loads.append({"index": index, "alignment": alignment,
                      "offset": offset, "vaddr": vaddr,
                      "congruent_16kb": congruent, "compatible_16kb": compatible})
    if not loads:
        raise ValueError("ELF has no LOAD segments")
    return {"bits": bits, "machine": machine, "loads": loads,
            "elf_16kb": all(load["compatible_16kb"] for load in loads)}


def native_abi(name, archive_type):
    parts = name.split("/")
    if archive_type == "apk" and len(parts) == 3 and parts[0] == "lib":
        return parts[1]
    if archive_type == "aab" and len(parts) == 4 and parts[1] == "lib":
        return parts[2]
    return None


def zip_payload_offset(raw, entry):
    raw.seek(entry.header_offset)
    header = raw.read(30)
    if len(header) != 30 or header[:4] != b"PK\x03\x04":
        raise ValueError("invalid ZIP local header")
    name_size, extra_size = struct.unpack_from("<HH", header, 26)
    return entry.header_offset + 30 + name_size + extra_size


def check_native_archive(path, archive_type, required_abis=RELEASE_ABIS):
    """Check every packaged .so, including ELF64 libraries stored as assets."""
    libraries, errors, valid_abis = [], [], set()
    result = {"artifact": str(path), "artifact_type": archive_type,
              "sha256": None, "page_size": PAGE_SIZE,
              "required_abis": list(required_abis), "libraries": libraries,
              "errors": errors}
    try:
        result["sha256"] = sha256_file(path)
        with path.open("rb") as raw, zipfile.ZipFile(path) as archive:
            bad_entry = archive.testzip()
            if bad_entry:
                errors.append(f"ZIP CRC failure: {bad_entry}")
            names = set()
            for entry in archive.infolist():
                if entry.filename in names:
                    errors.append(f"Duplicate ZIP entry: {entry.filename}")
                names.add(entry.filename)
                if entry.is_dir() or not entry.filename.endswith(".so"):
                    continue
                abi = native_abi(entry.filename, archive_type)
                library = {"path": entry.filename, "abi": abi, "bytes": entry.file_size}
                libraries.append(library)
                try:
                    elf = inspect_elf(archive.read(entry))
                    library.update({"bits": elf["bits"], "elf_16kb": elf["elf_16kb"],
                                    "load_alignments": [x["alignment"] for x in elf["loads"]],
                                    "loads_congruent_16kb": all(x["congruent_16kb"] for x in elf["loads"])})
                    expected = ABI_ELF.get(abi)
                    if expected and expected != (elf["bits"], elf["machine"]):
                        raise ValueError(f"ELF architecture does not match ABI {abi}")
                    if abi and expected:
                        valid_abis.add(abi)
                    if elf["bits"] == 64 and not elf["elf_16kb"]:
                        library["incompatible_loads"] = [x for x in elf["loads"] if not x["compatible_16kb"]]
                        errors.append(f"{entry.filename}: ELF64 LOAD segments are not 16 KB compatible")
                    if archive_type == "apk":
                        compressed = entry.compress_type != zipfile.ZIP_STORED
                        payload_offset = zip_payload_offset(raw, entry)
                        library.update({"zip_compressed": compressed,
                                        "zip_payload_offset": payload_offset,
                                        "zip_16kb": compressed or payload_offset % PAGE_SIZE == 0})
                        if elf["bits"] == 64 and not library["zip_16kb"]:
                            errors.append(f"{entry.filename}: uncompressed ELF64 ZIP payload is not 16 KB aligned")
                except (ValueError, struct.error) as error:
                    library["error"] = str(error)
                    errors.append(f"{entry.filename}: {error}")
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError, NotImplementedError) as error:
        errors.append(f"Cannot inspect artifact: {error}")

    native64 = [x for x in libraries if x.get("bits") == 64]
    result.update({"native_library_count": len(libraries),
                   "native64_count": len(native64),
                   "native32_count": sum(x.get("bits") == 32 for x in libraries),
                   "packaged_abis": sorted(valid_abis),
                   "all64_elf_pass": bool(native64) and all(x.get("elf_16kb") and not x.get("error") for x in native64)})
    if archive_type == "apk":
        result["all64_zip_pass"] = bool(native64) and all(x.get("zip_16kb") for x in native64)
    if not native64:
        errors.append("No ELF64 native libraries found")
    for abi in required_abis:
        if abi not in valid_abis:
            errors.append(f"Required native ABI is missing: {abi}")
    result["passed"] = not errors
    return result


def check_apk(path, required_abis=RELEASE_ABIS):
    return check_native_archive(Path(path), "apk", required_abis)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--required-abis", nargs="+", choices=RELEASE_ABIS, default=RELEASE_ABIS)
    args = parser.parse_args()
    report = check_apk(args.apk, args.required_abis)
    print(json.dumps(report, separators=(",", ":")))
    sys.exit(0 if report["passed"] else 1)
