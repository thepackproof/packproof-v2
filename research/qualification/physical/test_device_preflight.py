import importlib.util
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace

SPEC = importlib.util.spec_from_file_location("device_preflight", Path(__file__).with_name("device_preflight.py"))
device = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(device)


class PreflightTests(unittest.TestCase):
    def test_only_named_reads_and_serial_not_exported(self):
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            self.assertEqual(kwargs["timeout"], 20)
            if args[-1] == "devices": out = "List of devices attached\nPRIVATE-SERIAL\tdevice\n"
            elif args[-1] == "battery": out = "level: 72\nscale: 100\ntemperature: 321\nunknown: SECRET"
            elif args[-1] == "thermalservice": out = "Thermal Status: 0\nclient: PRIVATE"
            elif args[-1] == "media.camera": out = "client: PRIVATE\nandroid.info.supportedHardwareLevel (1): int32[1]\n [1]\n"
            else: out = "TEST-PROPERTY"
            return SimpleNamespace(returncode=0, stdout=out)
        result = device.collect(Path("adb"), None, run=run)
        self.assertEqual(len(calls), 10)
        self.assertTrue(all(a[1:] == ["devices"] or a[3:5] == ["shell", "getprop"] or a[3:5] == ["shell", "dumpsys"] for a in calls))
        self.assertNotIn("PRIVATE", str(result)); self.assertNotIn("SECRET", str(result))
        self.assertEqual(result["reads"]["battery"]["data"]["batteryTemperatureC"], 32.1)
        self.assertFalse(result["qualifiedProfile"])

    def test_multiple_and_unauthorized_devices_fail_closed(self):
        for output in ("A\tdevice\nB\tdevice\n", "A\tunauthorized\n", ""):
            with self.subTest(output=output), self.assertRaisesRegex(ValueError, "exactly one"):
                device.collect(Path("adb"), None, run=lambda *a, **kw: SimpleNamespace(returncode=0, stdout=output))

    def test_unavailable_thermal_not_reported_as_safe(self):
        result = device.parse_thermal("unrecognized OEM output")
        self.assertIsNone(result["reportedThermalStatus"])

    def test_camera_does_not_copy_non_numeric_next_line(self):
        result = device.parse_camera("android.request.availableCapabilities\nUser PRIVATE")
        self.assertIsNone(result["metadataEntries"][0]["reportedNumericValues"])
        self.assertNotIn("PRIVATE", str(result))

    def test_timeout_is_bounded_and_does_not_leak_command(self):
        def run(*args, **kwargs): raise subprocess.TimeoutExpired(["PRIVATE"], 20)
        with self.assertRaisesRegex(ValueError, "timed out") as caught:
            device.collect(Path("adb"), None, run=run)
        self.assertNotIn("PRIVATE", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
