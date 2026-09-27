import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";
import {
  createHarness,
  createUser,
  auth,
  type TestHarness,
} from "./helpers.js";
import {
  parseClientVersion,
  versionsSection,
} from "../src/admin/client-versions.js";

describe("Minimized client release monitoring", () => {
  let h: TestHarness, admin: string, user: string, other: string;
  let now = "2026-09-24T12:00:00.000Z";
  const clock = { now: () => new Date(now) };
  beforeAll(async () => {
    h = await createHarness(clock);
    admin = await createUser(h, "user_versions_admin");
    user = await createUser(h, "user_versions_one");
    other = await createUser(h, "user_versions_two");
    await h.db.query(
      "INSERT INTO user_system_roles(user_id,role,granted_at) VALUES($1,'SYSTEM_ADMIN',$2)",
      [admin, now],
    );
  }, 30000);
  afterAll(async () => h?.close());
  it("requires authentication and rejects invented/raw/device payload fields", async () => {
    expect(
      (
        await request(h.app)
          .post("/me/client-version")
          .send({ platform: "WEB", version: "1.0.0" })
      ).status,
    ).toBe(401);
    for (const payload of [
      { platform: "ANDROID", version: "1.0.1", deviceId: "private" },
      { platform: "WEB", version: "1.0.0", build: "unknown" },
      { platform: "WEB", version: "1.0.0", build: "Bearer secret" },
      { platform: "IOS", version: "x".repeat(100) },
      { platform: "LINUX", version: "1.0.0" },
      { platform: "WEB" },
    ])
      expect(
        (
          await request(h.app)
            .post("/me/client-version")
            .set(auth(user))
            .send(payload)
        ).status,
      ).toBe(400);
    expect(parseClientVersion({ platform: "WEB", version: "0.0.0" })).toEqual({
      platform: "WEB",
      version: "0.0.0",
      build: null,
    });
  });
  it("records latest version per authenticated user/platform and does not multiply user counts", async () => {
    for (const actor of [user, other]) {
      const r = await request(h.app)
        .post("/me/client-version")
        .set(auth(actor))
        .send({ platform: "ANDROID", version: "1.0.1", build: "54" });
      expect(r.status, JSON.stringify(r.body)).toBe(202);
    }
    expect(
      (
        await request(h.app)
          .post("/me/client-version")
          .set(auth(user))
          .send({ platform: "ANDROID", version: "1.0.1", build: "54" })
      ).status,
    ).toBe(202);
    expect(
      (await h.db.query("SELECT user_id,platform FROM client_version_activity"))
        .rows,
    ).toHaveLength(2);
    now = "2026-09-24T12:00:01.000Z";
    const s = await versionsSection(h, { period: "7d" });
    const row = s.rows.find(
      (r) => r.platform === "ANDROID" && r.version === "1.0.1",
    );
    expect(row?.users).toBe(2);
    expect(row?.build).toBe("54");
    expect(row?.error_rate).toBeNull();
    const serialized = JSON.stringify(s);
    expect(serialized).not.toContain(user);
    expect(serialized).not.toContain(other);
  });
  it("replaces only the reporting account release and retains other users", async () => {
    now = "2026-09-24T12:10:00.000Z";
    expect(
      (
        await request(h.app)
          .post("/me/client-version")
          .set(auth(user))
          .send({ platform: "ANDROID", version: "1.0.2", build: "55" })
      ).status,
    ).toBe(202);
    now = "2026-09-24T12:10:01.000Z";
    const response = await request(h.app)
      .get("/admin/sections/analytics?view=versions&period=7d")
      .set(auth(admin));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(
      response.body.rows.find(
        (r: Record<string, unknown>) => r.version === "1.0.1",
      ).users,
    ).toBe(1);
    expect(
      response.body.rows.find(
        (r: Record<string, unknown>) => r.version === "1.0.2",
      ).users,
    ).toBe(1);
    expect(
      (await request(h.app).get("/admin/sections/versions").set(auth(user)))
        .status,
    ).toBe(403);
  });
  it("keeps missing iOS/web versions explicitly unavailable and API build separate", async () => {
    const s = await versionsSection(
      {
        ...h,
        releaseIdentity: {
          service: "packproof-api",
          environment: "staging",
          version: "0.1.0",
          commit: "a".repeat(40),
          image: null,
        },
      },
      { period: "7d" },
    );
    const web = s.rows.find((r) => r.platform === "WEB");
    expect(web?.version).toBeNull();
    expect(web?.users).toBeNull();
    expect(web?.availability).toBe("unavailable");
    expect(s.rows.find((r) => r.platform === "API")?.build).toBe(
      "a".repeat(40),
    );
    expect(s.rows.find((r) => r.platform === "API")?.last_seen).toBeNull();
    const page = await versionsSection(h, {
      period: "7d",
      pageSize: "1",
      page: "2",
    });
    expect(page.rows).toHaveLength(1);
    expect(page.pagination.total).toBe(4);
  });
});
