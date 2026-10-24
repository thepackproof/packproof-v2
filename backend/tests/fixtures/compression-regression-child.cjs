'use strict';

// CVE-2026-111181 regression: loopback only, isolated from the test runner.
// No uncaughtException handler: a decoder crash must fail the child process.
const assert = require('node:assert/strict');
const { request } = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { gzipSync, deflateSync } = require('node:zlib');
const express = require('express');
const mode = process.argv[2];
assert.ok(['json', 'raw'].includes(mode));
const app = express();
const checks = [];
let finishTrailingRequest;
app.get('/health', (_req, res) => res.send('ok'));
app.post('/body', mode === 'raw'
  ? express.raw({ type: () => true, limit: '32kb' })
  : express.json({ limit: '32kb', verify() {} }), (req, res) => {
  const reply = () => res.status(401).json({
    parsed: mode === 'raw' ? req.body.toString('utf8') : req.body,
  });
  if (finishTrailingRequest) {
    req.once('end', reply);
    finishTrailingRequest();
  } else reply();
});
app.use((error, _req, res, _next) => res.status(error.status || 500).end());
const server = app.listen(0, '127.0.0.1');
const watchdog = setTimeout(() => process.exit(2), 10000);

async function send(body, encoding, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: server.address().port, agent: false,
      method: body ? 'POST' : 'GET', path: body ? '/body' : '/health',
      headers: body ? {
        'Content-Type': options.type || 'application/json',
        'Content-Encoding': encoding,
        'Content-Length': body.length + (options.trailing?.length || 0),
      } : {},
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('loopback request timed out')));
    if (options.trailing) {
      finishTrailingRequest = () => req.end(options.trailing);
      req.write(body);
    } else req.end(body);
  });
}

(async () => {
  await once(server, 'listening');
  const raw = Buffer.from('{ "value": "caf\u00e9", "count": 1 }\n');
  for (const [encoding, compress] of [['identity', x => x], ['gzip', gzipSync], ['deflate', deflateSync]]) {
    const response = await send(compress(raw), encoding);
    assert.equal(response.status, 401); // parsing still precedes authentication
    assert.deepEqual(JSON.parse(response.body).parsed, mode === 'raw' ? raw.toString() : JSON.parse(raw));
    checks.push(`${encoding}:valid-body`);
  }
  for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync]]) {
    assert.equal((await send(Buffer.from('invalid-frame'), encoding)).status, 400);
    assert.equal((await send(compress(raw).subarray(0, 8), encoding)).status, 400);
    assert.equal((await send(compress(Buffer.from(JSON.stringify({ value: 'x'.repeat(32768) }))), encoding)).status, 413);
    checks.push(`${encoding}:malformed-truncated-size-limit`);
  }
  assert.equal((await send(raw, 'unsupported-encoding')).status, 415);
  checks.push('unsupported-encoding');

  // Mirrors the upstream advisory's valid frame + NUL + later trailing bytes.
  // A single local request is sufficient to reproduce the old process crash.
  process.stderr.write('regression-stage: gzip-trailing-bytes\n');
  const trailingGzip = Buffer.concat([gzipSync(raw), Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]);
  assert.equal((await send(trailingGzip, 'gzip')).status, 401);
  await delay(200);
  assert.equal((await send()).body, 'ok');
  checks.push('gzip:trailing-bytes-survived');

  const first = Buffer.concat([deflateSync(raw), Buffer.from([0])]);
  assert.equal((await send(first, 'deflate', { trailing: Buffer.alloc(1024) })).status, 401);
  finishTrailingRequest = undefined;
  await delay(200);
  assert.equal((await send()).body, 'ok');
  checks.push('deflate:delayed-trailing-bytes-consumed');

  if (mode === 'json') {
    assert.equal((await send(trailingGzip, 'gzip', { type: 'application/json; charset=utf-999' })).status, 415);
    await delay(200);
    assert.equal((await send()).body, 'ok');
    checks.push('unsupported-charset:survived');
  }
  await new Promise(resolve => server.close(resolve));
  clearTimeout(watchdog);
  process.stdout.write(JSON.stringify({ mode, checks }) + '\n');
})().catch(error => {
  console.error(error);
  server.closeAllConnections();
  server.close();
  clearTimeout(watchdog);
  process.exitCode = 1;
});
