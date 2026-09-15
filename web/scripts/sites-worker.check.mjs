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

test("serves association JSON directly on apex and www, including extensionless AASA", async () => {
  for (const hostname of ["thepackproof.com", "www.thepackproof.com"]) {
    for (const pathname of ["/.well-known/assetlinks.json", "/.well-known/apple-app-site-association", "/apple-app-site-association"]) {
      const body = pathname.endsWith("assetlinks.json") ? [] : { applinks: { details: [] } };
      const seen = [];
      const env = { ASSETS: { fetch: async request => { seen.push(new URL(request.url).pathname); return Response.json(body); } } };
      const response = await worker.fetch(new Request(`https://${hostname}${pathname}`), env);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/json");
      assert.equal(response.headers.get("location"), null);
      assert.deepEqual(await response.json(), body);
      assert.deepEqual(seen, [pathname === "/apple-app-site-association" ? "/.well-known/apple-app-site-association" : pathname]);
    }
  }
});

test("does not publish SPA HTML or redirects as association documents", async () => {
  for (const response of [new Response("<!doctype html>"), Response.redirect("https://elsewhere.example", 302), new Response("missing", { status: 404 })]) {
    const result = await worker.fetch(new Request("https://www.thepackproof.com/.well-known/apple-app-site-association"), { ASSETS: { fetch: async () => response } });
    assert.equal(result.status, 404);
    assert.equal(result.headers.get("location"), null);
  }
});

test("handoff link previews only fetch static HTML and send no identifying referrer", async () => {
  const seen = [];
  const result = await worker.fetch(new Request("https://thepackproof.com/app/capture/handoff_safe", { method: "GET" }), { ASSETS: { fetch: async request => { seen.push(new URL(request.url).pathname); return new Response("HTML"); } } });
  assert.deepEqual(seen, ["/index.html"]);
  assert.equal(result.headers.get("referrer-policy"), "no-referrer");
});

test("redirects the public account deletion URL to the existing deletion flow", async () => {
  const response = await worker.fetch(new Request("https://thepackproof.com/delete-account?source=google-play"), {});
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://thepackproof.com/new/delete-account?source=google-play");
});

test("proxies only to the fixed API and never forwards the private Site cookie", async () => {
  const original = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url: String(url), options };
    return new Response('{"ok":true}', { headers: { "set-cookie": "unexpected=value" } });
  };
  try {
    const response = await worker.fetch(new Request("https://packproof.example/api//other.example/me?q=1", { headers: { authorization: "Bearer test", cookie: "private-access=secret", origin: "https://packproof.example", "idempotency-key": "capture-retry-123", "x-packproof-station-token": "station-capability", "x-shopify-hmac-sha256": "signed-webhook", "x-shopify-shop-domain": "fixture.myshopify.com", "x-shopify-topic": "orders/updated", "x-shopify-webhook-id": "delivery-fixture" } }), {});
    assert.equal(new URL(call.url).hostname, "pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws");
    assert.equal(call.options.headers.get("authorization"), "Bearer test");
    assert.equal(call.options.headers.get("idempotency-key"), "capture-retry-123");
    assert.equal(call.options.headers.get("x-packproof-station-token"), "station-capability");
    assert.equal(call.options.headers.get("x-shopify-hmac-sha256"), "signed-webhook");
    assert.equal(call.options.headers.get("x-shopify-shop-domain"), "fixture.myshopify.com");
    assert.equal(call.options.headers.get("x-shopify-topic"), "orders/updated");
    assert.equal(call.options.headers.get("x-shopify-webhook-id"), "delivery-fixture");
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
