import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SPIKE_EVENTS, beginSpikeRecording, createSpikeSession, endSpikeRecording,
  observeSpikeBarcode, serializeSpikeReport, stopSpikeDetection,
  type SpikeBarcodeInput,
} from "../src/capture/camera-spike-model.ts";

const START = 1_800_000_000_000;
const read = (overrides: Partial<SpikeBarcodeInput> = {}): SpikeBarcodeInput => ({
  rawValue: "TESTBARCODE4821", format: "code128", detectedAtMs: 1000,
  detectedAtUnixMs: START + 1000, latencyMs: 24, ...overrides,
});
const session = () => {
  const state = createSpikeSession("camera_spike_1", false);
  beginSpikeRecording(state, START);
  return state;
};

test("preview and late callbacks cannot enter the recording diagnostic index", () => {
  const state = createSpikeSession("camera_spike_1", false);
  assert.equal(observeSpikeBarcode(state, read()), null);
  assert.equal(state.totalScanCount, 0);
  beginSpikeRecording(state, START);
  assert.equal(observeSpikeBarcode(state, read({ detectedAtUnixMs: START - 1 })), null);
  assert.equal(observeSpikeBarcode(state, read())?.detectionIndex, 1);
  stopSpikeDetection(state);
  const stopped = serializeSpikeReport(state);
  assert.equal(observeSpikeBarcode(state, read({ rawValue: "OTHER9876" })), null);
  assert.deepEqual(serializeSpikeReport(state), stopped);
});

test("duplicate frames stay suppressed for the recording and cannot leak unmasked values", () => {
  const state = session();
  const event = observeSpikeBarcode(state, read())!;
  assert.equal(event.maskedValue, "•••• 4821");
  assert.equal(observeSpikeBarcode(state, read({ rawValue: " testbarcode4821 ", format: "CODE_128", detectedAtMs: 60_000 })), null);
  assert.equal(state.duplicateScanCount, 1);
  assert.equal(state.totalScanCount, 2);
  assert.equal(state.events.length, 1);
  assert.equal(observeSpikeBarcode(state, read({ format: "qr" }))?.detectionIndex, 2);
  event.maskedValue = "tampered";
  assert.equal(state.events[0].maskedValue, "•••• 4821");
  for (const serialized of [JSON.stringify(state), JSON.stringify(serializeSpikeReport(state))]) {
    assert.equal(serialized.includes("TESTBARCODE4821"), false);
    assert.equal(serialized.includes("rawValue"), false);
    assert.equal(serialized.includes("seen"), false);
  }
});

test("arbitrary QR contact and URL payloads are rejected without retaining PII substrings", () => {
  const state = session();
  for (const rawValue of [
    "https://example.test/order?name=JaneSmith", "www.example.test/JaneSmith",
    "mailto:jane@example.test", "jane@example.test", "tel:5551234567",
    "WIFI:S:PrivateFamilyName;T:WPA;P:PrivatePassword;;", "A".repeat(513), "test\nname",
  ]) assert.equal(observeSpikeBarcode(state, read({ rawValue, format: "qr" })), null);
  assert.equal(state.events.length, 0);
  const textEvent = observeSpikeBarcode(state, read({ rawValue: "Jane Smith", format: "qr" }));
  assert.equal(textEvent?.maskedValue, "[redacted]");
  const serialized = JSON.stringify(serializeSpikeReport(state));
  assert.equal(serialized.includes("Jane"), false);
  assert.equal(serialized.includes("5551234567"), false);
});

test("invalid format and nonfinite, fractional or unbounded clock values are rejected", () => {
  const state = session();
  for (const override of [
    { format: "madeup" }, { format: "x".repeat(33) }, { detectedAtMs: -1 },
    { detectedAtMs: NaN }, { detectedAtMs: 0.25 }, { detectedAtMs: 1_800_001 },
    { detectedAtUnixMs: Infinity }, { detectedAtUnixMs: START - 1 },
    { latencyMs: -1 }, { latencyMs: 60_001 },
  ]) assert.equal(observeSpikeBarcode(state, read(override)), null);
  assert.equal(state.rejectedScanCount, 10);
  assert.equal(state.events.length, 0);
  assert.equal(observeSpikeBarcode(state, read({ format: "DATA_MATRIX" }))?.format, "datamatrix");
});

test("scan flood keeps at most 32 unique events and retained identities remain deduplicated", () => {
  const state = session();
  for (let index = 0; index < 10_000; index++) {
    observeSpikeBarcode(state, read({ rawValue: `TEST${index}` }));
  }
  assert.equal(state.events.length, MAX_SPIKE_EVENTS);
  assert.equal(state.overflowScanCount, 10_000 - MAX_SPIKE_EVENTS);
  assert.equal(observeSpikeBarcode(state, read({ rawValue: "TEST0" })), null);
  assert.equal(state.duplicateScanCount, 1);
  assert.equal(state.events.at(-1)?.detectionIndex, MAX_SPIKE_EVENTS);
  assert.ok(JSON.stringify(serializeSpikeReport(state)).length < 10_000);
});

test("saved and interrupted recordings remain explicitly unverified diagnostics", () => {
  const state = session();
  observeSpikeBarcode(state, read());
  endSpikeRecording(state, { uri: "file:///data/camera-spike/test.mp4", durationMs: 10_000, byteSize: 200_000, interrupted: true });
  const report = serializeSpikeReport(state);
  assert.equal(report.source, "CAMERA_SPIKE");
  assert.equal(report.hardwareValidation, "UNVERIFIED");
  assert.equal(report.active, false);
  assert.equal(report.interrupted, true);
  assert.deepEqual(report.recording, { uri: "file:///data/camera-spike/test.mp4", durationMs: 10_000, byteSize: 200_000 });
  report.events[0].maskedValue = "modified";
  report.recording!.byteSize = 1;
  assert.equal(state.events[0].maskedValue, "•••• 4821");
  assert.equal(state.recording?.byteSize, 200_000);
  assert.equal("validated" in report, false);
  assert.throws(() => beginSpikeRecording(state, START + 10_000));
});

test("recording metadata cannot introduce remote URLs or nonfinite JSON values", () => {
  assert.throws(() => createSpikeSession("bad/path", false));
  assert.throws(() => createSpikeSession("A".repeat(81), false));
  assert.throws(() => beginSpikeRecording(createSpikeSession("test", false), NaN));
  for (const override of [
    { uri: "https://example.test/private" }, { uri: "file:///private\nname.mp4" },
    { durationMs: Infinity }, { durationMs: 0 }, { byteSize: NaN }, { byteSize: -1 },
  ]) {
    const state = session();
    assert.throws(() => endSpikeRecording(state, { uri: "file:///test.mp4", durationMs: 1000, byteSize: 1000, interrupted: false, ...override }));
    assert.equal(state.active, false);
    assert.equal(state.recording, null);
    assert.equal(serializeSpikeReport(state).hardwareValidation, "UNVERIFIED");
  }
});

test("a JS-observed interruption survives a later native result without an interruption flag", () => {
  const state = session();
  state.interrupted = true;
  stopSpikeDetection(state);
  endSpikeRecording(state, { uri: "file:///test.mp4", durationMs: 1000, byteSize: 1000, interrupted: false });
  assert.equal(serializeSpikeReport(state).interrupted, true);
  assert.equal(serializeSpikeReport(state).hardwareValidation, "UNVERIFIED");
});
