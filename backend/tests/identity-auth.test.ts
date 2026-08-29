import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { CognitoJwtAdapter } from "../src/auth/cognito-adapter.js";
import { createAuthentication, isDevLoginEnabled } from "../src/auth/create-auth.js";
import { loadConfig } from "../src/config.js";
import { ensureIdentityUser } from "../src/domain/users.js";
import { createApp } from "../src/app.js";
import { createHarness, type TestHarness } from "./helpers.js";

describe("authentication mode", () => {
  it("defaults explicitly to dev and rejects unknown modes", () => {
    expect(loadConfig({}).authMode).toBe("dev");
    expect(loadConfig({ PACKPROOF_AUTH_MODE: "dev" }).authMode).toBe("dev");
    expect(loadConfig({ PACKPROOF_AUTH_MODE: "cognito" }).authMode).toBe("cognito");
    expect(() => loadConfig({ PACKPROOF_AUTH_MODE: "auto" })).toThrow(
      /must be "dev" or "cognito"/,
    );
  });

  it("enables development login only in explicit dev mode", () => {
    expect(
      isDevLoginEnabled(
        loadConfig({ PACKPROOF_AUTH_MODE: "dev", PACKPROOF_DEV_AUTH: "true" }),
      ),
    ).toBe(true);
    expect(
      isDevLoginEnabled(
        loadConfig({ PACKPROOF_AUTH_MODE: "cognito", PACKPROOF_DEV_AUTH: "true" }),
      ),
    ).toBe(false);
    expect(
      isDevLoginEnabled(loadConfig({ PACKPROOF_AUTH_MODE: "dev", PACKPROOF_DEV_AUTH: "false" })),
    ).toBe(false);
  });

  it("requires Cognito pool configuration in cognito mode", () => {
    expect(() =>
      createAuthentication(
        loadConfig({ PACKPROOF_AUTH_MODE: "cognito" }),
        {} as never,
        { now: () => new Date() },
      ),
    ).toThrow(/PACKPROOF_COGNITO_USER_POOL_ID/);
  });
});

describe("external identity mapping", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("maps a Cognito subject to exactly one PackProof user and is idempotent", async () => {
    harness = await createHarness();
    const first = await ensureIdentityUser(
      harness.db,
      harness.clock,
      "cognito",
      "cognito-sub-seller",
    );
    const second = await ensureIdentityUser(
      harness.db,
      harness.clock,
      "cognito",
      "cognito-sub-seller",
    );
    const other = await ensureIdentityUser(
      harness.db,
      harness.clock,
      "cognito",
      "cognito-sub-buyer",
    );

    expect(first).toMatch(/^user_/);
    expect(second).toBe(first);
    expect(other).toMatch(/^user_/);
    expect(other).not.toBe(first);

    const mapped = await harness.db.query<{ user_id: string; provider: string }>(
      `SELECT user_id, provider FROM auth_identities
        WHERE provider = 'cognito' AND provider_subject = $1`,
      ["cognito-sub-seller"],
    );
    expect(mapped.rows).toEqual([{ user_id: first, provider: "cognito" }]);
  });

  it("derives the PackProof user from a verified Cognito token, never a client userId", async () => {
    harness = await createHarness();
    const adapter = new CognitoJwtAdapter(harness.db, harness.clock, {
      async verify(token) {
        if (token !== "valid-access-token") {
          throw new Error("unverified");
        }
        return {
          sub: "cognito-sub-from-jwt",
          token_use: "access",
          client_id: "mobile-client",
          iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example",
          exp: Math.floor(Date.now() / 1000) + 3600,
        };
      },
    });

    const first = await adapter.authenticate({ authorization: "Bearer valid-access-token" });
    const second = await adapter.authenticate({ authorization: "Bearer valid-access-token" });
    expect(first.userId).toMatch(/^user_/);
    expect(second.userId).toBe(first.userId);

    await expect(
      adapter.authenticate({ authorization: "Bearer not-a-verified-jwt" }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED", httpStatus: 401 });

    const spoof = await adapter.authenticate({
      authorization: "Bearer valid-access-token",
      "x-user-id": "user_SPOOFED",
    });
    expect(spoof.userId).toBe(first.userId);
  });

  it("does not expose development login when Cognito mode is selected", async () => {
    harness = await createHarness();
    const app = createApp({
      db: harness.db,
      objectStore: harness.objectStore,
      clock: harness.clock,
      auth: new CognitoJwtAdapter(harness.db, harness.clock, {
        async verify() {
          throw new Error("unused");
        },
      }),
      publicBaseUrl: "http://127.0.0.1",
      devAuth: false,
    });

    const response = await request(app).post("/auth/dev/login").send({ subject: "seller-1" });
    expect(response.status).toBe(404);
  });
});
