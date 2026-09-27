import { describe, expect, it, vi } from 'vitest';
import { NodeClient, type Event } from '@sentry/node';
import { ErrorReporting, scrubReport, validPublicDsn, type ErrorReportingClientOptions } from '../src/main/error-reporting.js';

const dsn = 'https://0123456789abcdef0123456789abcdef@o123.ingest.us.sentry.io/123';
describe('coded opt-in production reporting', () => {
  it('creates no provider without configuration and refuses development collection', () => {
    const create = vi.fn();
    expect(new ErrorReporting({ version: '1.0.0', channel: 'production', clientFactory: create }).state).toMatchObject({ enabled: false, configured: false });
    expect(new ErrorReporting({ dsn, version: '1.0.0', channel: 'development', clientFactory: create }).state.reason).toBe('DISABLED_IN_DEVELOPMENT');
    expect(create).not.toHaveBeenCalled();
  });
  it('accepts hosted public DSNs and rejects secret or off-domain endpoints', () => {
    expect(validPublicDsn(dsn)).toBe(true);
    for (const value of [dsn.replace('https:', 'http:'), dsn.replace('@', ':secret@'), dsn.replace('sentry.io', 'evil.example'), `${dsn}?token=secret`, `${dsn}#fragment`]) expect(validPublicDsn(value)).toBe(false);
  });
  it('disables automatic collection and accepts only whitelisted coded reports, at most once per minute', () => {
    const client = { captureEvent: vi.fn(), close: vi.fn(async () => true) }; let options!: ErrorReportingClientOptions; let now = 0;
    const reporter = new ErrorReporting({ dsn, channel: 'production', version: '1.0.0', now: () => now, clientFactory: input => { options = input; return client; } });
    reporter.record('SYSTEM', 'RENDERER_CRASH'); reporter.record('SYSTEM', 'RENDERER_CRASH');
    reporter.record('SYSTEM', 'Bearer_supersecret'); reporter.record('UNKNOWN', 'IPC_FAILURE');
    expect(client.captureEvent).toHaveBeenCalledTimes(1);
    expect(options.integrations).toEqual([]); expect(options.enableRuntimeChannelInjection).toBe(false);
    expect(options.includeServerName).toBe(false); expect(options.dataCollection?.httpBodies).toEqual([]);
    expect(options.dataCollection?.userInfo).toBe(false); expect(options.sendClientReports).toBe(false);
    now = 60_001; reporter.record('SYSTEM', 'RENDERER_CRASH'); expect(client.captureEvent).toHaveBeenCalledTimes(2);
  });
  it('reconstructs events after SDK processing, dropping scopes, raw exceptions, device names, traces and attachments', () => {
    const raw: Event = { event_id: 'a'.repeat(32), message: 'secret token', user: { email: 'private@example.test', ip_address: '127.0.0.1' }, server_name: 'Private-PC', request: { url: 'https://api.example.test?password=secret', data: 'video data' }, exception: { values: [{ value: '/Users/Private/Desktop/recording.mp4' }] }, extra: { proofId: 'proof_private' }, contexts: { trace: { trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16) } }, breadcrumbs: [{ message: 'private tracking number' }], tags: { category: 'CAPTURE', code: 'CAMERA_DISCONNECTED', accountId: 'user_private' } };
    const result = scrubReport(raw, 'packproof-desktop@1.0.0', 'production', 'win32');
    expect(Object.keys(result!).sort()).toEqual(['environment', 'event_id', 'fingerprint', 'level', 'message', 'platform', 'release', 'tags', 'type']);
    expect(JSON.stringify(result)).not.toMatch(/private|password|token|recording\.mp4|user_private|proof_private/i);
    expect(scrubReport({ tags: { category: 'CAPTURE', code: 'private' } }, 'v', 'production', 'win32')).toBeNull();
  });
  it('sends only the filtered event through the actual SDK transport without global initialization', async () => {
    const envelopes: unknown[] = [];
    const reporter = new ErrorReporting({ dsn, channel: 'staging', version: '1.0.0', platform: 'darwin', clientFactory: options => new NodeClient({ ...options, transport: () => ({ send: async envelope => { envelopes.push(envelope); return { statusCode: 200 }; }, flush: async () => true }) }) });
    reporter.record('UPLOAD', 'EVIDENCE_DIGEST_MISMATCH');
    await reporter.close();
    expect(envelopes).toHaveLength(1);
    const serialized = JSON.stringify(envelopes);
    expect(serialized).toContain('PackProof Desktop UPLOAD/EVIDENCE_DIGEST_MISMATCH');
    expect(serialized).toContain('packproof-desktop@1.0.0');
    expect(serialized).not.toMatch(/server_name|contexts|exception|breadcrumbs|request|user_id|filename/);
  });
});
