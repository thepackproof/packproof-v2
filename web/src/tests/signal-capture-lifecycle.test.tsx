import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PackProofApi } from '../api/client';
import { PackingStationScreen } from '../screens/PackingStationScreen';
import { recoverStationCapture, resumeStationRecording } from '../capture-queue';
import { canonicalProof } from './fixtures';

vi.mock('../capture-queue', async original => ({
  ...await original<typeof import('../capture-queue')>(),
  resumeStationRecording: vi.fn(async () => { throw new Error('Upload response lost'); }),
}));
vi.mock('../components/RelayStationPanel', () => ({ RelayStationPanel: () => null }));
let recorder: Recorder;
class Recorder {
  static isTypeSupported() { return true; }
  state = 'inactive'; mimeType = 'video/webm';
  ondataavailable: ((event: {data: Blob}) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor() { recorder = this; }
  start() { this.state = 'recording'; }
  stop = vi.fn(() => {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['retained original'], { type: this.mimeType }) });
    queueMicrotask(() => this.onstop?.());
  });
}
function api() {
  return {
    recoveryScope: 'https://signal.test',
    getProof: vi.fn(async () => ({ ...canonicalProof, status: 'READY_FOR_EVIDENCE', evidence: [], attestations: [], participationPolicy: 'COUNTERPARTY_OPTIONAL' })),
    getCapabilities: vi.fn(async () => ({ schemaVersion: 1, capture: { protocolVersions: [1], maxBytes: 1000000, maxDurationSeconds: 120, maxActiveUploads: 2 }, preservation: { receiptVersions: [1], durableReceiptsRequired: true }, shippingReview: { requiredForObservedConflicts: true, noLabelAllowed: true }, correctionPolicy: { importedFactsReadOnly: true, captureBindingLocksManualDetails: true }, sellerAttestation: { contextBindingVersion: 1 } })),
    createCaptureSession: vi.fn(async () => ({ id: 'capture-signal', state: 'ISSUED', maxRecordingBytes: 1000000, maxRecordingSeconds: 120 })),
    getCaptureShippingReview: vi.fn(async () => ({ currentTrackingNumber: null, reviewRequired: false, observations: [] })),
    featureRequest: vi.fn(async () => ({})),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('MediaRecorder', Recorder);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:signal-test' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 640 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function mount(client = api(), userId = crypto.randomUUID(), proofId = canonicalProof.proofId) {
  return { client, userId, ...render(<PackingStationScreen api={client as unknown as PackProofApi} userId={userId} initialProofId={proofId} queue={[]} error={null} onAuthExpired={() => {}} />) };
}
async function start() {
  const button = await screen.findByRole('button', { name: 'Start recording' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await screen.findByRole('button', { name: 'Finish recording' });
}
it('keeps permission denial retryable without creating a capture session', async () => {
  vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'));
  const { client } = mount();
  await screen.findByRole('alert');
  expect(client.createCaptureSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Enable camera' }));
  await start();
  expect(client.createCaptureSession).toHaveBeenCalledTimes(1);
});
it('persists an interrupted take without authorizing submission', async () => {
  const { userId } = mount(); await start();
  fireEvent(window, new Event('pagehide'));
  await screen.findByLabelText('Recorded packing video');
  await waitFor(async () => expect(await recoverStationCapture(userId)).toMatchObject({ interrupted: true, finishConfirmed: false }));
  expect(recorder.stop).toHaveBeenCalledTimes(1);
  expect(resumeStationRecording).not.toHaveBeenCalled();
});
it('retains the exact accepted operation after response loss and retries it after remount', async () => {
  const { userId, client, unmount } = mount(); await start();
  fireEvent.click(screen.getByRole('button', { name: 'Finish recording' }));
  await screen.findByLabelText('Recorded packing video');
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled());
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save to PackProof' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Save to PackProof' }));
  await screen.findByRole('button', { name: 'Resume saving' });
  const original = (await recoverStationCapture(userId))!;
  expect(original.finishConfirmed).toBe(true);
  expect(await original.file.text()).toBe('retained original');
  unmount(); mount(client, userId);
  await waitFor(() => expect(resumeStationRecording).toHaveBeenCalledTimes(2));
  const restored = (await recoverStationCapture(userId))!;
  expect(restored.uploadKey).toBe(original.uploadKey);
  expect(restored.captureSessionId).toBe(original.captureSessionId);
  expect(await restored.file.text()).toBe('retained original');
  expect(screen.queryByText('Proof saved.')).not.toBeInTheDocument();
});
