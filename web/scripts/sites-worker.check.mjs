import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./sites-worker.mjs";

test("serves app deep links through the HTML entry point and keeps asset 404s", async () => {
  const seen = [];
  const env = { ASSETS: { fetch: async request => { seen.push(new URL(request.url).pathname); return new Response("asset"); } } };
  await worker.fetch(new Request("https://packproof.example/proofs/proof_123"), env);
  await worker.fetch(new Request("https://packproof.example/missing.png"), env);
  assert.deepEqual(seen, ["/index.html", "/missing.png"]);
});

test("proxies only to the fixed API and never forwards the private Site cookie", async () => {
  const original = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url: String(url), options };
    return new Response('{"ok":true}', { headers: { "set-cookie": "unexpected=value" } });
  };
  try {
    const response = await worker.fetch(new Request("https://packproof.example/api//other.example/me?q=1", { headers: { authorization: "Bearer test", cookie: "private-access=secret", origin: "https://packproof.example", "idempotency-key": "capture-retry-123" } }), {});
    assert.equal(new URL(call.url).hostname, "pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws");
    assert.equal(call.options.headers.get("authorization"), "Bearer test");
    assert.equal(call.options.headers.get("idempotency-key"), "capture-retry-123");
    assert.equal(call.options.headers.get("cookie"), null);
    assert.equal(call.options.headers.get("origin"), null);
    assert.equal(call.options.redirect, "manual");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally { globalThis.fetch = original; }
});

test("redirects www to the main domain while preserving paths and query strings", async () => {
  const response = await worker.fetch(new Request("https://www.thepackproof.com/p/shared-proof?view=timeline"), {});
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://thepackproof.com/p/shared-proof?view=timeline");
});

test("returns a useful API error when the upstream cannot be reached", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network"); };
  try {
    const response = await worker.fetch(new Request("https://packproof.example/api/me"), {});
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "UPSTREAM_UNAVAILABLE");
  } finally { globalThis.fetch = original; }
});
