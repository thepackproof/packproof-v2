import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Clock } from "../src/clock.js";
import { linkVerifiedIdentity } from "../src/domain/external-identities.js";
import { consumeOAuthAttempt, createOAuthAttempt } from "../src/domain/oauth-attempts.js";
import { ensureIdentityUser } from "../src/domain/users.js";
import { auth, createHarness, login, type TestHarness } from "./helpers.js";

class AdjustableClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

describe("canonical external identities", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("links a verified provider subject to an existing PackProof account", async () => {
    harness = await createHarness();
    const userId = await login(harness.app, "seller-1");

    const linked = await linkVerifiedIdentity(harness.db, harness.clock, userId, {
      provider: "google",
      providerSubject: "google-sub-seller",
      providerHandle: "@collin",
      providerDisplayName: "Collin",
      avatarUrl: "https://lh3.googleusercontent.com/avatar.png",
    });

    expect(linked).toMatchObject({
      provider: "google",
      handle: "collin",
      displayName: "Collin",
      canAuthenticate: true,
      visibleOnProfile: false,
      searchable: false,
    });
    expect(linked.avatarUrl).toBe("https://lh3.googleusercontent.com/avatar.png");

    const listed = await request(harness.app).get("/me/identities").set(auth(userId));
    expect(listed.status).toBe(200);
    expect(listed.body.identities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "dev", canAuthenticate: true }),
        expect.objectContaining({ provider: "google", handle: "collin" }),
      ]),
    );
    expect(JSON.stringify(listed.body)).not.toContain("google-sub-seller");
    expect(JSON.stringify(listed.body)).not.toContain("seller-1");
  });

  it("rejects a provider subject that already belongs to another PackProof account", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "seller-1");
    const buyer = await login(harness.app, "buyer-1");
    await linkVerifiedIdentity(harness.db, harness.clock, seller, {
      provider: "google",
      providerSubject: "google-shared-sub",
    });

    await expect(
      linkVerifiedIdentity(harness.db, harness.clock, buyer, {
        provider: "google",
        providerSubject: "google-shared-sub",
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_ALREADY_LINKED", httpStatus: 409 });

    const buyerIdentities = await request(harness.app).get("/me/identities").set(auth(buyer));
    expect(buyerIdentities.body.identities).toEqual([
      expect.objectContaining({ provider: "dev" }),
    ]);
  });

  it("does not merge accounts because emails match", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "seller-1");
    const buyer = await login(harness.app, "buyer-1");
    await linkVerifiedIdentity(harness.db, harness.clock, seller, {
      provider: "google",
      providerSubject: "google-seller",
      metadata: { email: "same@example.com" },
    });
    await linkVerifiedIdentity(harness.db, harness.clock, buyer, {
      provider: "facebook",
      providerSubject: "facebook-buyer",
      metadata: { email: "same@example.com" },
    });

    const googleUser = await ensureIdentityUser(
      harness.db,
      harness.clock,
      "google",
      "google-seller",
    );
    const facebookUser = await ensureIdentityUser(
      harness.db,
      harness.clock,
      "facebook",
      "facebook-buyer",
    );
    expect(googleUser).toBe(seller);
    expect(facebookUser).toBe(buyer);
    expect(googleUser).not.toBe(facebookUser);

    const emailHits = await harness.db.query<{ user_id: string }>(
      `SELECT user_id FROM auth_identities WHERE metadata->>'email' = $1 ORDER BY user_id`,
      ["same@example.com"],
    );
    expect(emailHits.rows.map((row) => row.user_id).sort()).toEqual([buyer, seller].sort());
  });

  it("creates a new PackProof user for an unknown provider subject instead of attaching by email", async () => {
    harness = await createHarness();
    const existing = await login(harness.app, "seller-1");
    await harness.db.query(
      `UPDATE auth_identities SET metadata = '{"email":"collin@example.com"}'::jsonb
        WHERE user_id = $1`,
      [existing],
    );

    const created = await ensureIdentityUser(
      harness.db,
      harness.clock,
      "google",
      "google-new-subject",
    );
    expect(created).toMatch(/^user_/);
    expect(created).not.toBe(existing);
  });

  it("prevents unlinking the only remaining authentication method", async () => {
    harness = await createHarness();
    const userId = await login(harness.app, "seller-1");
    const denied = await request(harness.app).delete("/me/identities/dev").set(auth(userId));
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe("AUTH_METHOD_REQUIRED");

    await linkVerifiedIdentity(harness.db, harness.clock, userId, {
      provider: "google",
      providerSubject: "google-extra",
    });
    const unlinked = await request(harness.app).delete("/me/identities/google").set(auth(userId));
    expect(unlinked.status).toBe(204);

    const remaining = await request(harness.app).get("/me/identities").set(auth(userId));
    expect(remaining.body.identities).toEqual([
      expect.objectContaining({ provider: "dev", canAuthenticate: true }),
    ]);
  });

  it("does not let one PackProof account link two subjects for the same provider", async () => {
    harness = await createHarness();
    const userId = await login(harness.app, "seller-1");
    await linkVerifiedIdentity(harness.db, harness.clock, userId, {
      provider: "google",
      providerSubject: "google-first",
    });
    await expect(
      linkVerifiedIdentity(harness.db, harness.clock, userId, {
        provider: "google",
        providerSubject: "google-second",
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_PROVIDER_ALREADY_LINKED", httpStatus: 409 });
  });

  it("does not treat eBay as a PackProof sign-in identity and rejects client-supplied subjects", async () => {
    harness = await createHarness();
    const userId = await login(harness.app, "seller-1");

    await expect(
      linkVerifiedIdentity(harness.db, harness.clock, userId, {
        provider: "ebay",
        providerSubject: "ebay-user-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_IDENTITY_PROVIDER", httpStatus: 400 });

    const posted = await request(harness.app)
      .post("/me/identities")
      .set(auth(userId))
      .send({ provider: "google", providerSubject: "attacker-sub" });
    expect(posted.status).toBe(404);

    const spoofUnlink = await request(harness.app)
      .delete("/me/identities/ebay")
      .set(auth(userId));
    expect(spoofUnlink.status).toBe(400);
    expect(spoofUnlink.body.error.code).toBe("INVALID_IDENTITY_PROVIDER");
  });
});

describe("OAuth authorization attempts", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("creates a one-time state and rejects reuse or expiration", async () => {
    const clock = new AdjustableClock(new Date("2026-09-01T17:00:00.000Z"));
    harness = await createHarness(clock);
    const userId = await login(harness.app, "seller-1");

    const attempt = await createOAuthAttempt(harness.db, clock, {
      provider: "google",
      purpose: "link",
      userId,
    });
    expect(attempt.state).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(attempt)).not.toMatch(/secret|token|verifier/i);

    const consumed = await consumeOAuthAttempt(harness.db, clock, attempt.state);
    expect(consumed.userId).toBe(userId);
    expect(consumed.purpose).toBe("link");
    expect(consumed.codeVerifier).toEqual(expect.any(String));

    await expect(consumeOAuthAttempt(harness.db, clock, attempt.state)).rejects.toMatchObject({
      code: "OAUTH_STATE_REUSED",
    });

    const expired = await createOAuthAttempt(harness.db, clock, {
      provider: "ebay",
      purpose: "marketplace_connect",
      userId,
    });
    clock.advance(11 * 60 * 1000);
    await expect(consumeOAuthAttempt(harness.db, clock, expired.state)).rejects.toMatchObject({
      code: "OAUTH_STATE_EXPIRED",
    });
  });

  it("keeps marketplace connect distinct from PackProof sign-in", async () => {
    harness = await createHarness();
    const userId = await login(harness.app, "seller-1");

    await expect(
      createOAuthAttempt(harness.db, harness.clock, {
        provider: "ebay",
        purpose: "authenticate",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OAUTH_PURPOSE" });

    await expect(
      createOAuthAttempt(harness.db, harness.clock, {
        provider: "ebay",
        purpose: "link",
        userId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_OAUTH_PURPOSE" });

    await expect(
      createOAuthAttempt(harness.db, harness.clock, {
        provider: "google",
        purpose: "marketplace_connect",
        userId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_OAUTH_PURPOSE" });

    await expect(
      createOAuthAttempt(harness.db, harness.clock, {
        provider: "ebay",
        purpose: "marketplace_connect",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED", httpStatus: 401 });

    const connected = await createOAuthAttempt(harness.db, harness.clock, {
      provider: "ebay",
      purpose: "marketplace_connect",
      userId,
    });
    expect(connected.provider).toBe("ebay");
    expect(connected.purpose).toBe("marketplace_connect");
  });

  it("rejects an unknown OAuth state", async () => {
    harness = await createHarness();
    await expect(
      consumeOAuthAttempt(harness.db, harness.clock, "not-a-real-state"),
    ).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
  });
});
