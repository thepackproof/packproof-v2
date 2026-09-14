import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { CognitoJwtAdapter, type CognitoTokenClaims } from "../src/auth/cognito-adapter.js";
import { hasDeveloperAccess } from "../src/auth/developer-access.js";
import { createServerApp } from "../src/server-app.js";
import { createTenant, issueApiKey } from "../src/platform/tenants.js";
import { createWebhook, dispatchWebhooks } from "../src/platform/webhooks.js";
import { auth, createHarness, createUser, type TestHarness } from "./helpers.js";

let h: TestHarness;
let app: ReturnType<typeof createServerApp>;
const tokens = new Map<string, CognitoTokenClaims>();
beforeAll(async () => {
  h = await createHarness();
  app = createServerApp({ ...h, publicBaseUrl: "http://localhost", devAuth: false,
    auth: new CognitoJwtAdapter(h.db, h.clock, { verify: async token => {
      const claims = tokens.get(token); if (!claims) throw new Error("Invalid token"); return claims;
    } }),
  });
});
afterAll(async () => h?.close());

function identity(email: string, verified = true, subject = `subject-${tokens.size}`) {
  const token = `signed-token-${tokens.size}`;
  tokens.set(token, { sub: subject, token_use: "id", iss: "https://cognito.test", exp: Math.floor(h.clock.now().getTime() / 1000) + 3600, email, email_verified: verified });
  return token;
}
const access = (token: string) => request(app).get("/me/developer-access").set(auth(token));

it.each(["nericollin@gmail.com", "nericollin@thepackproof.com", "admin@thepackproof.com", "NERICOLLIN@THEPACKPROOF.COM"])("allows only verified approved account %s", async email => {
  const token = identity(email);
  const response = await access(token);
  expect(response.status).toBe(200); expect(response.body).toEqual({ allowed: true });
  expect(response.headers["cache-control"]).toContain("no-store");
  const tenant = await request(app).post("/me/tenants").set(auth(token)).send({ name: "Approved workspace" });
  expect(tenant.status, JSON.stringify(tenant.body)).toBe(201);
  const key = await request(app).post(`/me/tenants/${tenant.body.id}/keys`).set(auth(token)).send({ name: "Read only", scopes: ["proofs:read"] });
  expect(key.status).toBe(201);
  expect((await request(app).get("/v1/proofs/missing").set(auth(key.body.token))).status).toBe(404);
});

it.each(["someone@thepackproof.com", "nericollin+developer@gmail.com", "neri.collin@gmail.com", "admin@thepackproof.com.example.org", "nericollin@gmail.com.example.org"])("rejects unlisted account %s at every management route", async email => {
  const token = identity(email);
  expect((await access(token)).body).toEqual({ allowed: false });
  for (const [method, path] of [["get", "/me/tenants"], ["post", "/me/tenants"], ["get", "/me/tenants/old/keys"], ["post", "/me/tenants/old/keys"], ["delete", "/me/tenants/old/keys/old"], ["post", "/me/tenants/old/keys/old/rotate"]] as const) {
    const response = await request(app)[method](path).set(auth(token)).send({ name: "Spoofed", email: "admin@thepackproof.com", developerAccess: true, scopes: ["proofs:read"] });
    expect(response.status).toBe(403); expect(response.body.error.code).toBe("DEVELOPER_ACCESS_REQUIRED");
  }
});

it("does not grant privileges to unverified, anonymous, or self-asserted development identities", async () => {
  expect((await access(identity("admin@thepackproof.com", false))).body).toEqual({ allowed: false });
  expect((await request(app).get("/me/developer-access")).status).toBe(401);
  expect((await request(app).get("/me/tenants")).status).toBe(401);
  const user = await createUser(h, "admin@thepackproof.com");
  expect((await request(h.app).get("/me/developer-access").set(auth(user))).body).toEqual({ allowed: false });
  await expect(createTenant(h.db, h.clock, user, { name: "Direct bypass" })).rejects.toMatchObject({ httpStatus: 403 });
  expect((await request(h.app).get("/me").set(auth(user))).status).toBe(200);
});

it("blocks an existing key and queued webhook when verified ownership is lost", async () => {
  const token = identity("admin@thepackproof.com", true, "changing-account");
  const userId = (await request(app).get("/me").set(auth(token))).body.userId as string;
  const tenant = await createTenant(h.db, h.clock, userId, { name: "Existing" });
  const key = await issueApiKey(h.db, h.clock, userId, String(tenant.id), { name: "Existing key", scopes: ["proofs:read", "proofs:write"] });
  const config = { encryptionKey: Buffer.alloc(32, 7).toString("base64"), allowedHosts: ["hooks.example.com"] };
  await createWebhook(h.db, h.clock, String(tenant.id), { url: "https://hooks.example.com/events", eventTypes: ["proof.created"] }, config);
  const proof = await request(app).post("/v1/proofs").set(auth(key.token)).set("Idempotency-Key", "before-access-loss")
    .send({ externalId: "old-workspace-order", transaction: { itemTitle: "Test item", quantity: 1 } });
  expect(proof.status, JSON.stringify(proof.body)).toBe(201);
  expect(await hasDeveloperAccess(h.db, userId)).toBe(true);
  const changed = identity("admin@thepackproof.com", false, "changing-account");
  expect((await access(changed)).body).toEqual({ allowed: false });
  expect((await request(app).get("/v1/proofs/missing").set(auth(key.token))).status).toBe(403);
  await expect(issueApiKey(h.db, h.clock, userId, String(tenant.id), { name: "Bypass", scopes: ["proofs:read"] })).rejects.toMatchObject({ httpStatus: 403 });
  let sends = 0;
  const deliveries = await dispatchWebhooks(h.db, h.clock, config, async () => { sends++; return 204; }, 1);
  expect(deliveries.failed).toBe(1);
  expect(sends).toBe(0);
});
