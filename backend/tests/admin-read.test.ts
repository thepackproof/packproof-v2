import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";
import {
  createHarness,
  createUser,
  auth,
  commitProofEvidence,
  commitFulfillmentAndAttest,
  type TestHarness,
} from "./helpers.js";
import { analyticsSection, getRange, trend } from "../src/admin/analytics.js";
import { DomainError } from "../src/domain/errors.js";
import { integrityCheck, billingSection } from "../src/admin/read.js";
describe("System administration read boundary", () => {
  let h: TestHarness,
    admin: string,
    user: string,
    proof: string,
    evidence: string;
  let currentTime = "2026-09-24T12:00:00.000Z";
  const clock = { now: () => new Date(currentTime) };
  beforeAll(async () => {
    h = await createHarness(clock);
    admin = await createUser(h, "user_system_admin");
    user = await createUser(h, "user_ordinary");
    await h.db.query(
      "INSERT INTO user_system_roles(user_id,role,granted_at) VALUES($1,'SYSTEM_ADMIN',$2)",
      [admin, clock.now().toISOString()],
    );
    await h.db.query(
      "UPDATE users SET username='collector',username_normalized='collector',display_name='Collector' WHERE id=$1",
      [user],
    );
    await h.db.query(
      "INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'collector@example.com',$2,'COGNITO')",
      [user, clock.now().toISOString()],
    );
    const t = await request(h.app)
      .post("/transactions")
      .set(auth(user))
      .send({ itemTitle: "Rare comic" });
    expect(t.status).toBe(201);
    const p = await request(h.app)
      .post(`/transactions/${t.body.transactionId}/proof`)
      .set(auth(user));
    expect(p.status).toBe(200);
    proof = p.body.proofId;
    const e = await commitProofEvidence(h, user, proof, {
      contentType: "image/png",
      bytes: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkZkAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    evidence = e.evidenceId;
    await h.db.query(
      "INSERT INTO connected_accounts(id,user_id,provider,external_account_id,external_account_name,status,credential_reference,provider_metadata,created_at,updated_at) VALUES('conn_secret_test',$1,'ebay','external-1','Collector store','CONNECTED','DO_NOT_SERIALIZE_SECRET',$2,$3,$3)",
      [
        user,
        JSON.stringify({ access_token: "DO_NOT_SERIALIZE_SECRET" }),
        clock.now().toISOString(),
      ],
    );
    currentTime = "2026-09-24T12:00:01.000Z";
  }, 30000);
  afterAll(async () => {
    await h?.close();
  });
  it("forbids every read surface to ordinary and unauthenticated users", async () => {
    for (const path of [
      "/admin/overview",
      "/admin/search?q=collector",
      "/admin/sections/users",
      `/admin/proofs/${proof}/integrity`,
    ]) {
      expect((await request(h.app).get(path).set(auth(user))).status).toBe(403);
      expect((await request(h.app).get(path)).status).toBe(401);
    }
  });
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "rejects inherited section name %s for an authenticated administrator",
    async (name) => {
      const response = await request(h.app)
        .get(`/admin/sections/${name}`)
        .set(auth(admin));
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("ADMIN_SECTION_NOT_FOUND");
    },
  );
  it("continues to serve an explicitly registered section to administrators", async () => {
    const response = await request(h.app)
      .get("/admin/sections/users")
      .set(auth(admin));
    expect(response.status).toBe(200);
    expect(response.body.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: user })]),
    );
  });
  it("all explorer modules execute against migrated database without raw credentials", async () => {
    for (const name of [
      "users",
      "proofs",
      "evidence",
      "integrations",
      "analytics",
      "billing",
      "errors",
      "security",
      "audit",
      "infrastructure",
    ]) {
      const r = await request(h.app)
        .get(`/admin/sections/${name}`)
        .set(auth(admin));
      expect(r.status, `${name}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body.columns).toBeInstanceOf(Array);
      expect(r.body.rows).toBeInstanceOf(Array);
      expect(JSON.stringify(r.body)).not.toContain("DO_NOT_SERIALIZE_SECRET");
    }
  });
  it("shows real overview and strictly bounded queries", async () => {
    const r = await request(h.app).get("/admin/overview").set(auth(admin));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.health).toBeInstanceOf(Array);
    expect(
      r.body.metrics.find((m: { key: string }) => m.key === "total_users")
        .value,
    ).toBe(2);
    expect(
      r.body.metrics.find((m: { key: string }) => m.key === "proofs_created")
        .value,
    ).toBe(1);
    expect(
      (await request(h.app).get("/admin/users?pageSize=101").set(auth(admin)))
        .status,
    ).toBe(400);
    expect(
      (
        await request(h.app)
          .get("/admin/proofs?status=anything")
          .set(auth(admin))
      ).status,
    ).toBe(400);
    const page = await request(h.app)
      .get("/admin/users?pageSize=1&page=2")
      .set(auth(admin));
    expect(page.status).toBe(200);
    expect(page.body.rows).toHaveLength(1);
    expect(page.body.pagination.total).toBe(2);
  });
  it("searches identity and evidence and returns operational details safely", async () => {
    for (const query of ["collector@example.com", proof, evidence]) {
      const r = await request(h.app)
        .get("/admin/search")
        .query({ q: query })
        .set(auth(admin));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.results.length).toBeGreaterThan(0);
    }
    for (const path of [`/admin/users/${user}`, `/admin/proofs/${proof}`]) {
      const r = await request(h.app).get(path).set(auth(admin));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.sections.length).toBeGreaterThan(1);
      expect(JSON.stringify(r.body)).not.toContain("DO_NOT_SERIALIZE_SECRET");
    }
    const wildcard = await request(h.app)
      .get("/admin/users?q=%")
      .set(auth(admin));
    expect(wildcard.body.rows).toHaveLength(0);
  });
  it("reports integrity uncertainty for in-progress Proofs and reads objects without mutation", async () => {
    const result = await integrityCheck(h, proof);
    expect(result.status).toBe("WARNING");
    expect(
      result.checks.some(
        (c) => c.key === "evidence_object" && c.status === "PASS",
      ),
    ).toBe(true);
    expect(
      (
        await h.db.query("SELECT validation_status FROM evidence WHERE id=$1", [
          evidence,
        ])
      ).rows[0].validation_status,
    ).toBe("COMMITTED");
    expect(
      (
        await request(h.app)
          .patch(`/admin/proofs/${proof}`)
          .set(auth(admin))
          .send({ status: "FINALIZED" })
      ).status,
    ).toBe(404);
  });
  it("distinguishes corrupted storage from unavailable providers and opens detail modules", async () => {
    const bad = {
      ...h,
      objectStore: {
        ...h.objectStore,
        digest: async () => {
          throw new DomainError(
            "EVIDENCE_OBJECT_INTEGRITY_FAILURE",
            "Raw secret detail",
          );
        },
      },
    };
    const result = await integrityCheck(bad, proof);
    expect(result.status).toBe("FAIL");
    expect(JSON.stringify(result)).not.toContain("Raw secret detail");
    for (const path of [
      `/admin/evidence/${evidence}`,
      "/admin/integrations/conn_secret_test",
    ]) {
      const r = await request(h.app).get(path).set(auth(admin));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const u = await request(h.app).get(`/admin/users/${user}`).set(auth(admin));
    expect(
      u.body.actions.some((a: { id: string }) => a.id === "adjust-allowance"),
    ).toBe(false);
  });
  it("counts settled refund reversals in net receipts and links grouped failures", async () => {
    for (const [kind, at] of [
      ["payment_settled", "2026-09-23T01:00:00Z"],
      ["refund_settled", "2026-09-23T02:00:00Z"],
      ["refund_reversed", "2026-09-23T03:00:00Z"],
    ])
      await h.db.query(
        `INSERT INTO billing_payment_ledger(provider,environment,provider_account,subject_reference,kind,payment_reference,source_event_reference,user_id,occurred_at,amount_minor,currency,sha256) VALUES('stripe','live','acct','subject',$1,'payment','evt',$2,$3,1000,'USD',$4)`,
        [kind, user, at, "a".repeat(64)],
      );
    const bill = await billingSection(h, { period: "7d" });
    expect(bill.metrics.find((m) => m.key === "net")?.value).toBe(10);
    await h.db.query(
      "INSERT INTO api_request_audit(id,actor_user_id,operation,status,created_at) VALUES('api_failed',$1,'test',500,'2026-09-23T01:00:00Z')",
      [user],
    );
    const detail = await request(h.app)
      .get("/admin/errors/api%3AHTTP_500")
      .set(auth(admin));
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.actions.length).toBe(3);
  });
  it("verifies a finalized manifest and keeps admin mutations unavailable", async () => {
    await commitFulfillmentAndAttest(h, user, proof);
    const finalized = await request(h.app)
      .post(`/proofs/${proof}/finalize`)
      .set(auth(user));
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(200);
    const checked = await integrityCheck(h, proof);
    expect(checked.status, JSON.stringify(checked)).toBe("PASS");
    const before = await h.db.query(
      "SELECT sha256 FROM final_manifests WHERE proof_id=$1",
      [proof],
    );
    expect(
      (
        await request(h.app)
          .patch(`/admin/evidence/${evidence}`)
          .set(auth(admin))
          .send({ sha256: "0".repeat(64) })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.db.query(
          "SELECT sha256 FROM final_manifests WHERE proof_id=$1",
          [proof],
        )
      ).rows,
    ).toEqual(before.rows);
  });
  it("produces consistent previous-period trend and privacy-preserving acquisition/cohorts", async () => {
    const range = getRange(clock, { period: "7d" });
    expect(Date.parse(range.to) - Date.parse(range.from)).toBe(
      Date.parse(range.previousTo) - Date.parse(range.previousFrom),
    );
    const t = await trend(h.db, clock, {
      period: "7d",
      metric: "proofs_created",
    });
    expect(t.points).toHaveLength(7);
    for (const view of ["cohorts", "acquisition", "usage"]) {
      const s = await analyticsSection(h.db, clock, { period: "7d", view });
      expect(s.columns.length).toBeGreaterThan(0);
    }
    expect(() => getRange(clock, { period: "wrong" })).toThrow();
  });
});
