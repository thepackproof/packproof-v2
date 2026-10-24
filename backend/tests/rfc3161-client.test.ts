import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTimestampTransport, timestampEndpoint } from '../src/integrity/rfc3161-client.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));
const config = { endpoint: 'https://tsa.example.test/stamp', approvedHost: 'tsa.example.test' };
function response(options: { status?: number; mime?: string; encoding?: string; chunks?: Buffer[]; complete?: boolean } = {}) {
  const res: any = new EventEmitter();
  res.statusCode = options.status ?? 200;
  res.headers = { 'content-type': options.mime ?? 'application/timestamp-reply', 'content-encoding': options.encoding };
  res.complete = options.complete ?? true;
  res.destroy = vi.fn();
  vi.mocked(httpsRequest).mockImplementation(((_url: URL, _config: any, callback: any) => {
    const req: any = new EventEmitter();
    req.end = vi.fn(() => queueMicrotask(() => {
      callback(res);
      for (const part of options.chunks ?? [Buffer.from('synthetic-response')]) res.emit('data', part);
      res.emit('end');
    }));
    return req;
  }) as any);
  return res;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as any);
});
describe('bounded explicit RFC 3161 HTTPS transport', () => {
  it('refuses unapproved hosts, credentials, redirects encoded in the URL and IP literals', () => {
    expect(timestampEndpoint(config.endpoint, config.approvedHost).protocol).toBe('https:');
    for (const url of ['http://tsa.example.test/', 'https://other.example.test/', 'https://u:p@tsa.example.test/', 'https://tsa.example.test:8443/', 'https://tsa.example.test/?target=elsewhere', 'https://tsa.example.test/#fragment', 'https://127.0.0.1/'])
      expect(() => timestampEndpoint(url, config.approvedHost)).toThrow();
  });
  it('pins the resolved public address while retaining hostname TLS validation and exact request bytes', async () => {
    response();
    const transport = createTimestampTransport(config), bytes = Buffer.from([1, 2, 3]);
    await expect(transport(bytes)).resolves.toEqual(Buffer.from('synthetic-response'));
    const options: any = vi.mocked(httpsRequest).mock.calls[0][1];
    expect(options.headers['Content-Type']).toBe('application/timestamp-query');
    expect(options.headers['Content-Length']).toBe('3');
    expect(options.rejectUnauthorized).not.toBe(false);
    const callback = vi.fn(); options.lookup('tsa.example.test', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect((vi.mocked(httpsRequest).mock.results[0].value as any).end).toHaveBeenCalledWith(bytes);
  });
  it('rejects DNS rebinding to private or mixed public/private addresses before TLS', async () => {
    for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '::1']) {
      vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }] as any);
      await expect(createTimestampTransport(config)(Buffer.from([1]))).rejects.toThrow('ENDPOINT_NOT_PUBLIC');
    }
    expect(httpsRequest).not.toHaveBeenCalled();
  });
  it.each([{ status: 302 }, { status: 500 }, { mime: 'text/html' }, { encoding: 'gzip' }])('closes an unacceptable provider response: %j', async options => {
    const res = response(options);
    await expect(createTimestampTransport(config)(Buffer.from([1]))).rejects.toThrow('RESPONSE_HTTP_INVALID');
    expect(res.destroy).toHaveBeenCalled();
  });
  it('bounds response bytes and rejects a truncated HTTP message', async () => {
    const res = response({ chunks: [Buffer.alloc(512 * 1024), Buffer.from([1])] });
    await expect(createTimestampTransport(config)(Buffer.from([1]))).rejects.toThrow('RESPONSE_SIZE');
    expect(res.destroy).toHaveBeenCalled();
    response({ complete: false });
    await expect(createTimestampTransport(config)(Buffer.from([1]))).rejects.toThrow('RESPONSE_INCOMPLETE');
  });
  it('rejects oversized requests without DNS or network work', async () => {
    await expect(createTimestampTransport(config)(Buffer.alloc(4097))).rejects.toThrow('REQUEST_SIZE');
    expect(lookup).not.toHaveBeenCalled(); expect(httpsRequest).not.toHaveBeenCalled();
  });
});
