import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { gzipSync, deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from './helpers.js';
import { shopifyWebhookHmac } from '../src/integrations/shopify/hmac.js';
import { FakeShopifyClient } from './fixtures/connected-accounts.js';

describe('compressed request process survival', () => {
  it.each(['json', 'raw'])('%s remains alive after malformed and trailing compressed bytes', mode => {
    const child = spawnSync(process.execPath, [
      fileURLToPath(new URL('./fixtures/compression-regression-child.cjs', import.meta.url)), mode,
    ], { encoding: 'utf8', timeout: 12000, maxBuffer: 128 * 1024 });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.mode).toBe(mode);
    expect(result.checks).toContain('gzip:trailing-bytes-survived');
    expect(result.checks).toContain('deflate:delayed-trailing-bytes-consumed');
  });
});

describe('actual server JSON and signed webhook compatibility', () => {
  let harness: TestHarness;
  let server: Server;
  const codecs = [['identity', (value: Buffer) => value], ['gzip', gzipSync], ['deflate', deflateSync]] as const;
  const secret = 'synthetic-parser-hmac-fixture';
  beforeAll(async () => {
    harness = await createHarness(undefined, { shopify: {
      enabled: true, clientId: 'fixture-client', appCredentialReference: 'memory:shopify-app',
      redirectUri: 'http://127.0.0.1/oauth/shopify/callback', client: new FakeShopifyClient(),
    } });
    await harness.credentialStore.put({ adapterKey: 'shopify', credentialReference: 'memory:shopify-app', material: { clientSecret: secret } });
    server = harness.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }, 30000);
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await harness?.close();
  });
  async function post(path: string, body: Buffer, encoding: string, headers: Record<string, string> = {}) {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback TCP listener');
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1', port: address.port, path, method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': encoding, 'Content-Length': String(body.length), ...headers },
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          try { resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch (error) { reject(error); }
        });
      });
      request.on('error', reject);
      request.setTimeout(5000, () => request.destroy(new Error('loopback request timed out')));
      request.end(body);
    });
  }
  for (const [encoding, compress] of codecs) {
    it(`accepts ${encoding} JSON through createServerApp`, async () => {
      const result = await post('/auth/dev/login', compress(Buffer.from(JSON.stringify({ subject: `parser-${encoding}` }))), encoding);
      expect(result.status).toBe(200);
      expect(result.body.userId).toBeTypeOf('string');
    });
    it(`preserves ${encoding} webhook bytes and rejects a mismatched signature`, async () => {
      const raw = Buffer.from('{ "id": 123, "note": "caf\u00e9" }\n');
      const headers = {
        'X-Shopify-Topic': 'orders/create', 'X-Shopify-Webhook-Id': `parser-${encoding}`,
        'X-Shopify-Shop-Domain': 'proof-store.myshopify.com',
        'X-Shopify-Hmac-Sha256': shopifyWebhookHmac(secret, raw),
      };
      const accepted = await post('/integrations/webhooks/shopify', compress(raw), encoding, headers);
      expect(accepted.status).toBe(200);
      expect(accepted.body).toEqual({ accepted: true, queued: false });
      const rejected = await post('/integrations/webhooks/shopify', compress(Buffer.concat([raw, Buffer.from(' ')])), encoding, headers);
      expect(rejected.status).toBe(401);
    });
  }
});
