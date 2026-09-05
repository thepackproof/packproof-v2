import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { BearerUserAdapter } from "../src/auth/adapter.js";
import { createApp } from "../src/app.js";
import { createServerApp } from "../src/server-app.js";
import { auth, login } from "./helpers.js";
import { createHarness, type TestHarness } from "./helpers.js";

describe("web origin CORS", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("allows the configured web origin and rejects an unknown origin", async () => {
    harness = await createHarness();
    const app = createApp({
      db: harness.db,
      objectStore: harness.objectStore,
      clock: harness.clock,
      auth: new BearerUserAdapter(harness.db),
      publicBaseUrl: "http://127.0.0.1",
      devAuth: true,
      corsOrigins: ["http://127.0.0.1:5173"],
    });

    const allowed = await request(app)
      .options("/me/proofs")
      .set("Origin", "http://127.0.0.1:5173");
    expect(allowed.status).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");

    const denied = await request(app).options("/me/proofs").set("Origin", "https://evil.example");
    expect(denied.status).toBe(204);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    expect(denied.headers.vary).toContain("Origin");
  });

  it("covers actual email-control responses and errors at the production boundary", async () => {
    harness = await createHarness();
    const origin = "https://app.packproof.example";
    const app = createServerApp({
      db: harness.db,
      objectStore: harness.objectStore,
      clock: harness.clock,
      auth: new BearerUserAdapter(harness.db),
      publicBaseUrl: "http://127.0.0.1",
      devAuth: true,
      corsOrigins: [origin],
    });
    const seller = await login(app, "cors-email-seller");
    const transaction = await request(app).post("/transactions").set(auth(seller)).send({});
    const proof = await request(app)
      .post(`/transactions/${transaction.body.transactionId}/proof`)
      .set(auth(seller));
    const path = `/proofs/${proof.body.proofId}/email-subscriptions`;
    const preflight = await request(app).options(path).set("Origin", origin);
    expect(preflight.status).toBe(204);
    const response = await request(app).get(path).set(auth(seller)).set("Origin", origin);
    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    const unauthorized = await request(app).get(path).set("Origin", origin);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers["access-control-allow-origin"]).toBe(origin);
    const publicControl = await request(app)
      .get("/public/proofs/invalid-token/email-subscription")
      .set("Origin", origin);
    expect(publicControl.status).toBe(404);
    expect(publicControl.headers["access-control-allow-origin"]).toBe(origin);
    const denied = await request(app).get(path).set(auth(seller)).set("Origin", "https://evil.example");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
