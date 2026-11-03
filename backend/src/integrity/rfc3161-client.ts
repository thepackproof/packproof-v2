/** Explicit operator-selected HTTPS TSA transport. No default provider. */
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { publicAddress } from '../platform/webhooks.js';

export function timestampEndpoint(endpoint: string, approvedHost: string): URL {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.hostname !== approvedHost || !approvedHost.includes('.') || url.username || url.password || url.hash || url.search || (url.port && url.port !== '443') || isIP(url.hostname)) throw Error('TIMESTAMP_ENDPOINT_NOT_APPROVED');
  return url;
}
export function createTimestampTransport(config: { endpoint: string; approvedHost: string }) {
  const url = timestampEndpoint(config.endpoint, config.approvedHost);
  return async (request: Uint8Array): Promise<Buffer> => {
    if (!request.length || request.length > 4096) throw Error('TIMESTAMP_REQUEST_SIZE');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([
      lookup(url.hostname, { all: true }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('TIMESTAMP_DNS_TIMEOUT')), 5000); }),
    ]).finally(() => clearTimeout(timer));
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw Error('TIMESTAMP_ENDPOINT_NOT_PUBLIC');
    const selected = addresses[0];
    return new Promise<Buffer>((resolve, reject) => {
      const req = httpsRequest(url, {
        method: 'POST', family: selected.family,
        headers: { 'Content-Type': 'application/timestamp-query', Accept: 'application/timestamp-reply', 'Content-Length': String(request.length) },
        lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
        signal: AbortSignal.timeout(10000),
      }, res => {
        res.on('error', () => reject(Error('TIMESTAMP_RESPONSE_INCOMPLETE')));
        // No redirects, content decoding, alternate provider or hostname fallback.
        if (res.statusCode !== 200 || res.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/timestamp-reply' || res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
          res.destroy(); reject(Error('TIMESTAMP_RESPONSE_HTTP_INVALID')); return;
        }
        let length = 0;
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 512 * 1024) { res.destroy(); reject(Error('TIMESTAMP_RESPONSE_SIZE')); }
          else parts.push(chunk);
        });
        res.on('end', () => { if (!res.complete || !length) reject(Error('TIMESTAMP_RESPONSE_INCOMPLETE')); else resolve(Buffer.concat(parts)); });
        res.on('aborted', () => reject(Error('TIMESTAMP_RESPONSE_INCOMPLETE')));
      });
      req.on('error', () => reject(Error('TIMESTAMP_TRANSPORT_UNAVAILABLE')));
      req.end(request);
    });
  };
}
