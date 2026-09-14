export type RelayRole = 'CONTROLLER' | 'CAMERA';
export type RelayCommand = { sequence: number; type: 'SELECT_ORDER' | 'START' | 'FINISH' | 'NEXT'; proofId?: string; idempotencyKey: string };
export type RelayAck = { sequence: number; captureSessionId?: string };
export type RelayStation = { id: string; state: string; paired: boolean; proofId: string | null; captureSessionId: string | null; lastSequence: number; acknowledgedSequence: number; expiresAt: string; commands: RelayCommand[]; capture?: { state: string } | null };
export type RelayDevice = { version: 1; id: string; role: RelayRole; token: string; pairingUrl?: string; pendingCommand?: RelayCommand; pendingAck?: RelayAck; pendingStart?: { sequence: number; captureSessionId: string; proofId: string } };
export type RelayClient = { apiBaseUrl: string; assertCaptureAccount(userId: string, apiBaseUrl: string): void; relayRequest<T>(path?: string, method?: string, body?: unknown, token?: string): Promise<T> };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function relayStorageKey(baseUrl: string, userId: string) { return `packproof.relay.v1:${encodeURIComponent(baseUrl)}:${encodeURIComponent(userId)}`; }
export function readRelayCommand(value: unknown): RelayCommand {
  if (!object(value) || !sequence(value.sequence) || value.sequence < 1 || !['SELECT_ORDER', 'START', 'FINISH', 'NEXT'].includes(String(value.type)) || !id(value.idempotencyKey) || (value.proofId != null && !id(value.proofId))) throw new Error('The station command could not be verified. Refresh the station.');
  return { sequence: value.sequence, type: value.type as RelayCommand['type'], ...(value.proofId ? { proofId: value.proofId as string } : {}), idempotencyKey: value.idempotencyKey as string };
}
export function readRelayStation(value: unknown, expectedId?: string): RelayStation {
  if (!object(value) || !id(value.id) || (expectedId && value.id !== expectedId) || !['PAIRING', 'READY', 'SELECTED', 'RECORDING', 'SAVING', 'SAVED', 'CANCELLED'].includes(String(value.state)) || typeof value.paired !== 'boolean' || !sequence(value.lastSequence) || !sequence(value.acknowledgedSequence) || value.acknowledgedSequence > value.lastSequence || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) || (value.proofId != null && !id(value.proofId)) || (value.captureSessionId != null && !id(value.captureSessionId))) throw new Error('The station response could not be verified. Refresh the station.');
  const commands = value.commands === undefined ? [] : Array.isArray(value.commands) ? value.commands.map(readRelayCommand) : null;
  if (!commands || commands.some((command, index) => command.sequence !== Number(value.acknowledgedSequence) + index + 1 || command.sequence > Number(value.lastSequence))) throw new Error('The station command order could not be verified.');
  if (value.capture != null && (!object(value.capture) || typeof value.capture.state !== 'string')) throw new Error('The recording state could not be verified.');
  return { id: value.id, state: value.state as string, paired: value.paired, proofId: value.proofId as string | null, captureSessionId: value.captureSessionId as string | null, lastSequence: value.lastSequence, acknowledgedSequence: value.acknowledgedSequence, expiresAt: value.expiresAt, commands, capture: value.capture as RelayStation['capture'] };
}
export function readRelayDevice(raw: string | null): RelayDevice | null {
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!object(value) || value.version !== 1 || !id(value.id) || !['CONTROLLER', 'CAMERA'].includes(String(value.role)) || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) throw new Error('Saved station credentials could not be read. Your recordings remain on this device.');
  const result: RelayDevice = { version: 1, id: value.id, role: value.role as RelayRole, token: value.token };
  if (typeof value.pairingUrl === 'string' && parseRelayPairing(value.pairingUrl)?.id === value.id) result.pairingUrl = value.pairingUrl;
  if (value.pendingCommand) result.pendingCommand = readRelayCommand(value.pendingCommand);
  if (value.pendingAck) {
    const ack = value.pendingAck;
    if (!object(ack) || !sequence(ack.sequence) || ack.sequence < 1 || (ack.captureSessionId != null && !id(ack.captureSessionId))) throw new Error('The pending camera acknowledgement is invalid. Keep this station for recovery.');
    result.pendingAck = { sequence: ack.sequence, ...(ack.captureSessionId ? { captureSessionId: ack.captureSessionId as string } : {}) };
  }
  if (value.pendingStart) {
    const start = value.pendingStart;
    if (!object(start) || !sequence(start.sequence) || start.sequence < 1 || !id(start.captureSessionId) || !id(start.proofId)) throw new Error('The original station recording could not be identified.');
    result.pendingStart = { sequence: start.sequence, captureSessionId: start.captureSessionId, proofId: start.proofId };
  }
  return result;
}
export function parseRelayPairing(text: string): { id: string; token: string } | null {
  try {
    const url = new URL(text.trim());
    if (url.username || url.password || url.port || !['https:', 'packproof:', 'packproof-v2:'].includes(url.protocol)) return null;
    const path = url.protocol === 'https:' ? url.pathname : `/${url.hostname}${url.pathname}`;
    if (url.protocol === 'https:' && !['thepackproof.com', 'www.thepackproof.com', 'app.thepackproof.com'].includes(url.hostname)) return null;
    if (!/^\/(?:app\/)?station\/?$/.test(path)) return null;
    const params = new URLSearchParams(url.hash.replace(/^#/, '') || url.search), stationId = params.get('relay'), token = params.get('pair');
    return id(stationId) && /^relay_/.test(stationId) && token && /^[A-Za-z0-9_-]{43}$/.test(token) ? { id: stationId, token } : null;
  } catch { return null; }
}
export function canSelectRelayOrder(station: RelayStation): boolean { return station.paired && station.lastSequence === station.acknowledgedSequence && (!station.captureSessionId ? ['READY', 'SELECTED', 'SAVED'].includes(station.state) : station.capture?.state === 'COMMITTED'); }
export class RelayScope {
  private active = true;
  private foreground = true;
  private revision = 0;
  constructor(private readonly client: RelayClient, private readonly userId: string, private readonly current: () => boolean = () => true) {}
  setForeground(value: boolean) { if (this.foreground !== value) { this.foreground = value; this.revision++; } }
  dispose() { this.active = false; this.revision++; }
  lease() {
    const revision = this.revision, baseUrl = this.client.apiBaseUrl;
    const assert = () => { if (!this.active || !this.foreground || !this.current() || revision !== this.revision) throw new Error('Reopen this station in the original account to continue.'); this.client.assertCaptureAccount(this.userId, baseUrl); };
    assert();
    return { assert, request: async <T>(path = '', method = 'GET', body?: unknown, token?: string): Promise<T> => { assert(); const value = await this.client.relayRequest<T>(path, method, body, token); assert(); return value; } };
  }
}
/** Persist command intent before transport; an uncertain result replays the exact command. */
export async function sendRelayCommand(input: { device: RelayDevice; station: RelayStation; type: RelayCommand['type']; proofId?: string; key: string; persist: (device: RelayDevice) => Promise<void>; request: <T>(path: string, method: string, body: unknown, token: string) => Promise<T> }): Promise<RelayDevice> {
  const { device, station } = input;
  if (device.role !== 'CONTROLLER' || device.id !== station.id) throw new Error('Open the paired controller before sending commands.');
  const command = device.pendingCommand ?? { sequence: station.lastSequence + 1, type: input.type, ...(input.proofId || station.proofId ? { proofId: input.proofId || station.proofId! } : {}), idempotencyKey: input.key };
  if (!device.pendingCommand) {
    if (station.lastSequence !== station.acknowledgedSequence) throw new Error('Wait for the camera to acknowledge the preceding command.');
    if ((command.type === 'SELECT_ORDER' || command.type === 'NEXT') && !canSelectRelayOrder(station)) throw new Error('Finish saving the current recording before choosing another order.');
    if (command.type === 'START' && station.state !== 'SELECTED') throw new Error('Select the same order on both devices before starting.');
    if (command.type === 'FINISH' && station.state !== 'RECORDING') throw new Error('The camera has not acknowledged a recording.');
  }
  const pending = { ...device, pendingCommand: command };
  await input.persist(pending);
  const accepted = await input.request<unknown>(`/${encodeURIComponent(device.id)}/commands`, 'POST', command, device.token);
  readRelayStation(accepted, device.id);
  if (!object(accepted) || JSON.stringify(readRelayCommand(accepted.command)) !== JSON.stringify(command)) throw new Error('Command acceptance could not be verified. Retry the same command.');
  const complete = { ...pending, pendingCommand: undefined };
  await input.persist(complete);
  return complete;
}
