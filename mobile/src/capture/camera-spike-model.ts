/** Local camera diagnostics only. Nothing in this module authorizes or binds Proof evidence. */
export const MAX_SPIKE_EVENTS = 32;
const MAX_BARCODE_LENGTH = 512;
const MAX_DURATION_MS = 30 * 60_000;
const MAX_UNIX_MS = 8_640_000_000_000_000;
const MAX_LATENCY_MS = 60_000;
const MAX_RECORDING_BYTES = 16 * 1024 ** 3;

const FORMATS = [
  "qr", "pdf417", "aztec", "ean13", "ean8", "upc_a", "upc_e",
  "code39", "code93", "code128", "codabar", "itf14", "datamatrix",
] as const;
export type SpikeBarcodeFormat = (typeof FORMATS)[number];

export interface SpikeBarcodeInput {
  rawValue: string;
  format: string;
  detectedAtMs: number;
  detectedAtUnixMs: number;
  latencyMs: number;
}

export interface SpikeBarcodeEvent {
  detectionIndex: number;
  maskedValue: string;
  format: SpikeBarcodeFormat;
  detectedAtMs: number;
  detectedAtUnixMs: number;
  latencyMs: number;
}

export interface SpikeRecording {
  uri: string;
  durationMs: number;
  byteSize: number;
}

export interface SpikeReport {
  source: "CAMERA_SPIKE";
  hardwareValidation: "UNVERIFIED";
  sessionId: string;
  audioEnabled: boolean;
  active: boolean;
  startedAtUnixMs: number | null;
  events: SpikeBarcodeEvent[];
  totalScanCount: number;
  duplicateScanCount: number;
  rejectedScanCount: number;
  overflowScanCount: number;
  interrupted: boolean;
  recording: SpikeRecording | null;
}

export type SpikeSession = SpikeReport;

// Raw values exist only in bounded, in-memory duplicate suppression. Even an accidental
// JSON.stringify(session) cannot include them. Never put this set in a diagnostic report.
const internals = new WeakMap<SpikeSession, { seen: Set<string> }>();

function integerInRange(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function internal(state: SpikeSession): { seen: Set<string> } {
  const value = internals.get(state);
  if (!value) throw new Error("Unknown camera spike session.");
  return value;
}

function barcodeFormat(value: string): SpikeBarcodeFormat | null {
  if (typeof value !== "string" || value.length > 32) return null;
  const compact = value.trim().toLowerCase().replace(/[_-]/g, "");
  const aliases: Record<string, SpikeBarcodeFormat> = {
    qrcode: "qr", upca: "upc_a", upce: "upc_e", itf: "itf14",
  };
  const normalized = aliases[compact] ?? compact;
  return (FORMATS as readonly string[]).includes(normalized)
    ? normalized as SpikeBarcodeFormat : null;
}

function normalizedBarcode(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > MAX_BARCODE_LENGTH) return null;
  const value = raw.trim();
  // Arbitrary QR links, contact details and structured payloads do not belong in
  // this diagnostic index. No URL/contact substring is extracted for masking.
  if (!value || /[^\x20-\x7E]/.test(raw) ||
      /:\/\/|www\.|@/i.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  return value.toUpperCase();
}

export function createSpikeSession(sessionId: string, audioEnabled: boolean): SpikeSession {
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)) {
    throw new Error("A bounded camera spike session identifier is required.");
  }
  if (typeof audioEnabled !== "boolean") throw new Error("Audio mode must be explicit.");
  const state: SpikeSession = {
    source: "CAMERA_SPIKE", hardwareValidation: "UNVERIFIED", sessionId, audioEnabled,
    active: false, startedAtUnixMs: null, events: [], totalScanCount: 0,
    duplicateScanCount: 0, rejectedScanCount: 0, overflowScanCount: 0,
    interrupted: false, recording: null,
  };
  internals.set(state, { seen: new Set() });
  return state;
}

export function beginSpikeRecording(state: SpikeSession, startedAtUnixMs: number): void {
  internal(state);
  if (state.startedAtUnixMs !== null) throw new Error("Use a new spike session for each recording.");
  if (!integerInRange(startedAtUnixMs, 1, MAX_UNIX_MS)) throw new Error("Invalid recording start time.");
  state.startedAtUnixMs = startedAtUnixMs;
  state.active = true;
}

/** Call only for native analyzer events; preview, malformed and late events are ignored. */
export function observeSpikeBarcode(state: SpikeSession, input: SpikeBarcodeInput): SpikeBarcodeEvent | null {
  const { seen } = internal(state);
  if (!state.active || state.startedAtUnixMs === null) return null;
  state.totalScanCount = Math.min(Number.MAX_SAFE_INTEGER, state.totalScanCount + 1);
  const format = barcodeFormat(input.format);
  const value = normalizedBarcode(input.rawValue);
  if (!format || !value ||
      !integerInRange(input.detectedAtMs, 0, MAX_DURATION_MS) ||
      !integerInRange(input.detectedAtUnixMs, state.startedAtUnixMs, MAX_UNIX_MS) ||
      !integerInRange(input.latencyMs, 0, MAX_LATENCY_MS)) {
    state.rejectedScanCount = Math.min(Number.MAX_SAFE_INTEGER, state.rejectedScanCount + 1);
    return null;
  }
  const key = `${format}\0${value}`;
  if (seen.has(key)) {
    state.duplicateScanCount = Math.min(Number.MAX_SAFE_INTEGER, state.duplicateScanCount + 1);
    return null;
  }
  if (state.events.length >= MAX_SPIKE_EVENTS) {
    // Only the 32 retained event identities need deduplication. All other callbacks
    // count as overflow, keeping memory bounded even when an analyzer floods events.
    state.overflowScanCount = Math.min(Number.MAX_SAFE_INTEGER, state.overflowScanCount + 1);
    return null;
  }
  seen.add(key);
  const event: SpikeBarcodeEvent = {
    detectionIndex: state.events.length + 1,
    maskedValue: /^[A-Z0-9]+$/.test(value) ? `•••• ${value.slice(-4)}` : "[redacted]",
    format, detectedAtMs: input.detectedAtMs, detectedAtUnixMs: input.detectedAtUnixMs,
    latencyMs: input.latencyMs,
  };
  state.events.push(event);
  return { ...event };
}

/** Invoke synchronously when stopping, before waiting for native recording completion. */
export function stopSpikeDetection(state: SpikeSession): void {
  internal(state);
  state.active = false;
}

export function endSpikeRecording(state: SpikeSession, recording: SpikeRecording & { interrupted: boolean }): void {
  internal(state);
  state.active = false;
  if (state.startedAtUnixMs === null) throw new Error("The camera spike recording has not started.");
  if (state.recording) throw new Error("The camera spike recording has already ended.");
  if (typeof recording.interrupted !== "boolean") throw new Error("Interruption state must be explicit.");
  // JS can observe backgrounding before native finalization reports its status.
  // Once either side observes an interruption it must survive a later false result.
  state.interrupted = state.interrupted || recording.interrupted;
  if (typeof recording.uri !== "string" || recording.uri.length > 2048 ||
      !/^file:\/\/\//.test(recording.uri) || /[\u0000-\u001F\u007F]/.test(recording.uri) ||
      !integerInRange(recording.durationMs, 1, MAX_DURATION_MS) ||
      !integerInRange(recording.byteSize, 1, MAX_RECORDING_BYTES)) {
    throw new Error("A saved local recording with bounded duration and byte size is required.");
  }
  state.recording = { uri: recording.uri, durationMs: recording.durationMs, byteSize: recording.byteSize };
  internal(state).seen.clear();
}

/** Explicit allowlist: no raw values, private dedup state, carrier claims or inferred pass flag. */
export function serializeSpikeReport(state: SpikeSession): SpikeReport {
  internal(state);
  return {
    source: "CAMERA_SPIKE", hardwareValidation: "UNVERIFIED", sessionId: state.sessionId,
    audioEnabled: state.audioEnabled, active: state.active, startedAtUnixMs: state.startedAtUnixMs,
    events: state.events.map(({ detectionIndex, maskedValue, format, detectedAtMs, detectedAtUnixMs, latencyMs }) => ({
      detectionIndex, maskedValue, format, detectedAtMs, detectedAtUnixMs, latencyMs,
    })),
    totalScanCount: state.totalScanCount, duplicateScanCount: state.duplicateScanCount,
    rejectedScanCount: state.rejectedScanCount, overflowScanCount: state.overflowScanCount,
    interrupted: state.interrupted,
    recording: state.recording ? { ...state.recording } : null,
  };
}
