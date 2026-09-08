import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PackProofV2Client } from "../src/v2-api.ts";
import { automaticIntakeStatus, orderIntakeExplanation, providerSetupMessage } from "../src/copy/commerce.ts";

test("mobile Etsy connection and intake commands send only explicit actions to authenticated canonical routes", async () => {
  const requests: Array<{ method: string; url: string; body: string; authorization: string }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    requests.push({ method: req.method!, url: req.url!, body, authorization: req.headers.authorization ?? "" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url?.endsWith("/connect")
      ? { authorizationUrl: "https://www.etsy.com/oauth/connect?client_id=public", provider: "etsy" }
      : { connections: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const client = new PackProofV2Client({ baseUrl: `http://127.0.0.1:${address.port}`, getToken: () => "fixture-session" });
  try {
    const started = await client.startConnectedAccountConnect("etsy");
    assert.equal(started.provider, "etsy");
    assert.equal(requests.length, 1, "connecting must not implicitly enable automation");
    await client.listIntegrationConnections("commerce");
    await client.setCommerceAutomation("etsy/account", true);
    await client.setCommerceAutomation("etsy/account", false);
    await client.syncCommerceConnection("etsy/account");
    await client.reauthorizeConnectedAccount("account_etsy");
    await client.disconnectConnectedAccount("account_etsy");
    assert.deepEqual(requests.map(({ method, url, body }) => ({ method, url, body })), [
      { method: "POST", url: "/me/connected-accounts/etsy/connect", body: "{}" },
      { method: "GET", url: "/me/integration-connections?capability=commerce", body: "" },
      { method: "POST", url: "/me/commerce-connections/etsy%2Faccount/automation", body: '{"enabled":true}' },
      { method: "POST", url: "/me/commerce-connections/etsy%2Faccount/automation", body: '{"enabled":false}' },
      { method: "POST", url: "/me/commerce-connections/etsy%2Faccount/sync", body: "{}" },
      { method: "POST", url: "/me/connected-accounts/account_etsy/reauthorize", body: "{}" },
      { method: "DELETE", url: "/me/connected-accounts/account_etsy", body: "" },
    ]);
    assert(requests.every(request => request.authorization === "Bearer fixture-session"));
    assert(!requests.some(request => /secret|access_token|refresh_token|orders|proofs/.test(request.body)));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("mobile Etsy guidance separates server setup, intake preparation and deliberate evidence capture", () => {
  assert.match(providerSetupMessage("etsy"), /approved Etsy app/);
  assert.match(orderIntakeExplanation("etsy"), /existing paid, unshipped physical orders first/);
  assert.match(orderIntakeExplanation("etsy"), /submit your attestation yourself/);
  assert.match(automaticIntakeStatus({ status: "NEEDS_REAUTH", autoSyncEnabled: true }), /paused/);
  assert.equal(automaticIntakeStatus({ status: "ACTIVE", autoSyncEnabled: false }), "Automatic intake off");
});
