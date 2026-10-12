"""Opt-in, read-only Android inventory. No install, settings change, capture or stress test."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

PROPERTIES = {
    "manufacturer": "ro.product.manufacturer", "model": "ro.product.model",
    "androidVersion": "ro.build.version.release", "sdk": "ro.build.version.sdk",
    "buildDisplayId": "ro.build.display.id", "securityPatch": "ro.build.version.security_patch",
}
CAMERA_KEYS = ("android.info.supportedHardwareLevel", "android.request.availableCapabilities", "android.sensor.info.activeArraySize", "android.scaler.availableStreamConfigurations")


def parse_battery(raw: str) -> dict:
    wanted = {"level", "scale", "status", "health", "temperature", "voltage", "AC powered", "USB powered", "Wireless powered"}
    values = {}
    for line in raw.splitlines():
        key, sep, value = line.strip().partition(":")
        if sep and key in wanted:
            values[key] = value.strip()
    result = {"reportedFields": values, "temperatureMeaning": "battery sensor, not camera/SoC or skin temperature"}
    if re.fullmatch(r"-?\d+", values.get("temperature", "")):
        result["batteryTemperatureC"] = int(values["temperature"]) / 10
    return result


def parse_thermal(raw: str) -> dict:
    match = re.search(r"(?im)^\s*Thermal Status:\s*(\d+)\s*$", raw)
    return {"reportedThermalStatus": int(match.group(1)) if match else None,
            "interpretation": "observed platform status only; no device-specific safe operating envelope inferred"}


def parse_camera(raw: str) -> dict:
    lines = raw.splitlines()
    result = []
    for index, line in enumerate(lines):
        if any(key in line for key in CAMERA_KEYS):
            # Camera metadata uses a following bracketed scalar/vector. Do not copy clients,
            # application names, serials, service history or unrelated dump sections.
            key = next(key for key in CAMERA_KEYS if key in line)
            values = None
            if index + 1 < len(lines):
                next_line = lines[index + 1].strip()
                if re.fullmatch(r"\[[\s\d,.;+-]*\]", next_line) and len(next_line) <= 2048:
                    values = next_line
            result.append({"metadataKey": key, "reportedNumericValues": values})
            if len(result) >= 128:
                break
    return {"metadataEntries": result, "completeCapabilityInventory": False,
            "limits": "OEM dumps vary; absent/partial fields mean unavailable. No camera was opened and no stream profile was validated."}


def collect(adb: Path, serial: str | None, run=subprocess.run) -> dict:
    def call(args):
        try:
            result = run([str(adb), *args], capture_output=True, text=True, timeout=20, check=False)
        except subprocess.TimeoutExpired:
            raise ValueError("ADB read timed out") from None
        if result.returncode:
            # Do not copy arbitrary device/service stderr into the public receipt.
            raise ValueError("ADB read failed; inspect the device connection locally")
        if len(result.stdout) > 8 * 1024 * 1024:
            raise ValueError("ADB response exceeds bounded inventory size")
        return result.stdout
    devices = []
    for line in call(["devices"]).splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == "device":
            devices.append(parts[0])
    if serial is None:
        if len(devices) != 1:
            raise ValueError("connect exactly one authorized device or explicitly choose --serial")
        serial = devices[0]
    if serial not in devices or not re.fullmatch(r"[A-Za-z0-9_.:-]+", serial):
        raise ValueError("selected device is not in the authorized connected inventory")
    prefix = ["-s", serial, "shell"]
    properties = {key: call([*prefix, "getprop", prop]).strip()[:256] for key, prop in PROPERTIES.items()}
    result = {"schemaVersion": "packproof.passive-device-inventory.v1", "observedAt": datetime.now(timezone.utc).isoformat(),
              "properties": properties, "qualifiedProfile": False, "cameraOpened": False,
              "installedOrSettingsChanged": False, "physicalCapturePerformed": False,
              "serialOmitted": True, "reads": {}, "limits": ["This inventory cannot establish recorder continuity, thermal safety, capture quality or physical-study readiness.", "No capture, installation or study is performed by this inventory; those use the authorized research workflow."]}
    for key, command, parser in (("battery", "battery", parse_battery), ("thermal", "thermalservice", parse_thermal), ("camera", "media.camera", parse_camera)):
        try:
            result["reads"][key] = {"state": "OBSERVED", "data": parser(call([*prefix, "dumpsys", command]))}
        except ValueError as exc:
            result["reads"][key] = {"state": "UNAVAILABLE", "reason": str(exc)}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb", type=Path, required=True)
    parser.add_argument("--serial")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.exit(2, "inventory rejected: output already exists\n")
    try:
        if not args.adb.is_file():
            raise ValueError("supply the actual local adb executable")
        report = collect(args.adb, args.serial)
        with args.output.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(report, handle, indent=2, sort_keys=True)
            handle.write("\n")
        print(json.dumps({"output": str(args.output), "qualifiedProfile": False}))
    except (ValueError, OSError) as exc:
        parser.exit(2, "inventory rejected: " + str(exc) + "\n")


if __name__ == "__main__":
    main()
