import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { BearerUserAdapter } from "../src/auth/adapter.js";
import { createApp } from "../src/app.js";
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
  });
});
