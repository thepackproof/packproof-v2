import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const CachePolicy = require('http-cache-semantics');

describe('desktop build dependency compatibility', () => {
  it('retains explicit private, authenticated and revalidation cache boundaries', () => {
    const request = { url: 'https://download.example.test/artifact', headers: {} };
    const reuseRequest = { ...request, headers: { 'cache-control': 'max-stale=999999' } };
    for (const control of ['private, max-age=300', 'no-store']) {
      const policy = new CachePolicy(request, { status: 200, headers: { 'cache-control': control } });
      expect(policy.storable(), control).toBe(false);
    }
    const authenticated = new CachePolicy({ ...request, headers: { authorization: 'Bearer synthetic-fixture' } },
      { status: 200, headers: { 'cache-control': 'max-age=300' } });
    expect(authenticated.storable()).toBe(false);
    const revalidate = new CachePolicy(request, { status: 200, headers: { 'cache-control': 'public, max-age=0, must-revalidate' } });
    expect(revalidate.satisfiesWithoutRevalidation(reuseRequest)).toBe(false);
    const publicArtifact = new CachePolicy(request, { status: 200, headers: { 'cache-control': 'public, max-age=300' } });
    expect(publicArtifact.storable()).toBe(true);
    expect(publicArtifact.satisfiesWithoutRevalidation(request)).toBe(true);
    expect(publicArtifact.satisfiesWithoutRevalidation({ ...request, headers: { 'cache-control': 'no-cache, max-stale=999999' } })).toBe(false);
  });

  it('preserves the electron-builder download adapter proxy and NO_PROXY behavior', () => {
    // Isolate global-agent's intentional Node HTTP monkeypatch from other tests.
    // The actual @electron/get adapter must load the overridden package and route requests.
    const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
    const downloadRequire = createRequire(builderRequire.resolve('@electron/get/package.json'));
    const adapterPath = downloadRequire.resolve('./dist/cjs/proxy.js');
    const script = `
      const assert = require('node:assert/strict');
      const http = require('node:http');
      const { once } = require('node:events');
      (async () => {
        const proxied = [];
        const proxy = http.createServer((req, res) => { proxied.push(req.url); res.end('through-proxy'); });
        const origin = http.createServer((_req, res) => res.end('direct-origin'));
        proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
        origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
        try {
          process.env.GLOBAL_AGENT_HTTP_PROXY = 'http://127.0.0.1:' + proxy.address().port;
          process.env.GLOBAL_AGENT_HTTPS_PROXY = process.env.GLOBAL_AGENT_HTTP_PROXY;
          process.env.GLOBAL_AGENT_NO_PROXY = '127.0.0.1';
          require(process.argv[1]).initializeProxy();
          assert.equal(global.GLOBAL_AGENT.HTTP_PROXY, process.env.GLOBAL_AGENT_HTTP_PROXY);
          const get = url => new Promise((resolve, reject) => {
            http.get(url, res => { let body=''; res.on('data', x => body += x); res.on('end', () => resolve(body)); }).on('error', reject);
          });
          assert.equal(await get('http://packproof-build.invalid/artifact'), 'through-proxy');
          assert.equal(await get('http://127.0.0.1:' + origin.address().port + '/bypass'), 'direct-origin');
          assert.deepEqual(proxied, ['http://packproof-build.invalid/artifact']);
          console.log('proxy and NO_PROXY passed');
        } finally {
          proxy.closeAllConnections(); origin.closeAllConnections(); proxy.close(); origin.close();
        }
      })().catch(error => { console.error(error.message); process.exitCode=1; });
    `;
    expect(execFileSync(process.execPath, ['-e', script, adapterPath], { timeout: 10_000, encoding: 'utf8' }))
      .toContain('proxy and NO_PROXY passed');
  });
});
