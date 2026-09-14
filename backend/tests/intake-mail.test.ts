import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { createPgliteDatabase } from "../src/db/pglite.js";
import { splitSqlStatements } from "../src/db/sql.js";
import type { Database } from "../src/db/database.js";
import { parseMail, MAIL_LIMITS, forwardingChallenge, inertHtmlText } from "../src/intake/mail-parser.js";
import { createMailAlias, listMailSetup, acceptTrustedSesReceipt, dispatchMailJobs, acknowledgeMailVerification, revokeMailAlias, replayMailReceipt, type MailTemplate } from "../src/intake/mail.js";

const config = { topicArn: "arn:aws:sns:us-east-1:123456789012:intake", bucket: "private-intake", keyPrefix: "raw/" };
const message = (body: string, subject = "Sale") => Buffer.from(`From: seller@example.test\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);
const verification = Buffer.from("From: forwarding-noreply@google.com\r\nSubject: Gmail Forwarding Confirmation\r\nContent-Type: text/plain\r\n\r\nConfirmation code: 123456789");
function queue(address: string, id = "delivery1", overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ Type: "Notification", TopicArn: config.topicArn, Message: JSON.stringify({ notificationType: "Received", mail: { messageId: id, commonHeaders: { to: ["spoofed@intake.example.test"] } }, receipt: { recipients: [address], spamVerdict: { status: "PASS" }, virusVerdict: { status: "PASS" }, action: { type: "S3", bucketName: config.bucket, objectKey: `${config.keyPrefix}${id}` } }, ...overrides }) });
}
// Synthetic parser seam exercises worker contracts only. It is NEVER registered as a supported seller family.
const syntheticTemplate: MailTemplate = { key: "synthetic-test-only", version: "1", provider: "ebay", validatedFixtureSha256: "a".repeat(64), matches: mail => mail.subject === "Sale", parse: () => ({ externalOrderId: "exact-id", orderReference: "display-number", items: [{ title: "Widget", quantity: 2, variant: "Blue" }], paid: true, physicalFulfillment: true, cancelled: false, fulfillmentScope: "FULL_ORDER" }) };
let opened: Awaited<ReturnType<typeof createPgliteDatabase>>, db: Database;
let timestamp: number;
const clock = { now: () => new Date(timestamp) };
beforeEach(async (context) => {
  if (context.task.suite?.name === "bounded inert MIME parser") return;
  timestamp = Date.parse("2026-09-08T15:00:00Z");
  opened = await createPgliteDatabase(); db = opened.db;
  await db.query(`CREATE TABLE users(id text PRIMARY KEY)`);
  await db.query(`CREATE TABLE integration_connections(id text PRIMARY KEY,owner_user_id text REFERENCES users(id),provider text,external_account_reference text,status text)`);
  await db.query(`INSERT INTO users VALUES('seller'),('other')`);
  await db.query(`INSERT INTO integration_connections VALUES('store','seller','ebay','verified-store','ACTIVE'),('other-store','other','ebay','other-store','ACTIVE')`);
  const migration = await readFile(new URL("../migrations/056_intake_mail.sql", import.meta.url), "utf8");
  for (const sql of splitSqlStatements(migration)) await db.query(sql);
});
afterEach(async (context) => { if (context.task.suite?.name !== "bounded inert MIME parser") await opened?.close(); });
async function alias() { return createMailAlias(db, clock, { ownerUserId: "seller", connectionId: "store", domain: "intake.example.test" }); }
async function verifiedAlias() {
  const a = await alias();
  await acceptTrustedSesReceipt(db, clock, queue(a.address, "verification"), config);
  await dispatchMailJobs(db, clock, { readRawObject: async () => verification, submitObservation: async () => { throw Error("Verification cannot create an order"); } });
  const challenge = (await listMailSetup(db, clock, "seller"))[0].challenge!;
  await acknowledgeMailVerification(db, clock, "seller", a.id, challenge.id);
  return a;
}

describe("mail intake ownership, setup and crash recovery", () => {
  it("scopes random revocable aliases to a verified owned store and trusts envelope recipients only", async () => {
    const a = await alias();
    expect((await alias()).id).toBe(a.id);
    await expect(createMailAlias(db, clock, { ownerUserId: "seller", connectionId: "other-store", domain: "intake.example.test" })).rejects.toMatchObject({ code: "MAIL_STORE_UNVERIFIED" });
    expect(await listMailSetup(db, clock, "other")).toEqual([]);
    expect(await acceptTrustedSesReceipt(db, clock, queue("unknown@intake.example.test"), config)).toEqual({ accepted: 0, ignored: 1 });
    await expect(acceptTrustedSesReceipt(db, clock, queue(a.address), { ...config, topicArn: "wrong" })).rejects.toMatchObject({ code: "MAIL_INGRESS_INVALID" });
    await expect(acceptTrustedSesReceipt(db, clock, JSON.stringify({ Type: "Notification", TopicArn: config.topicArn, Message: "null" }), config)).rejects.toMatchObject({ code: "MAIL_INGRESS_INVALID" });
    await acceptTrustedSesReceipt(db, clock, queue(a.address), config);
    await acceptTrustedSesReceipt(db, clock, queue(a.address), config);
    expect((await db.query(`SELECT * FROM intake_mail_receipts`)).rows).toHaveLength(1);
    await expect(revokeMailAlias(db, clock, "other", a.id)).rejects.toMatchObject({ code: "MAIL_ALIAS_NOT_FOUND" });
    await revokeMailAlias(db, clock, "seller", a.id);
    expect(await acceptTrustedSesReceipt(db, clock, queue(a.address, "after-revoke"), config)).toEqual({ accepted: 0, ignored: 1 });
    expect((await alias()).address).not.toBe(a.address);
  });
  it("verification is private and expiring, and insufficient/unknown sale cannot activate setup", async () => {
    const a = await verifiedAlias();
    expect((await listMailSetup(db, clock, "seller"))[0]).toMatchObject({ state: "AWAITING_VALID_SAMPLE", challenge: null, supportedTemplates: [] });
    await acceptTrustedSesReceipt(db, clock, queue(a.address, "unknown"), config);
    let submitted = false;
    await dispatchMailJobs(db, clock, { readRawObject: async () => message("You made a sale; open the app"), submitObservation: async () => { submitted = true; throw Error(); } });
    expect(submitted).toBe(false);
    expect((await listMailSetup(db, clock, "seller"))[0]).toMatchObject({ state: "AWAITING_VALID_SAMPLE", lastErrorCode: "UNSUPPORTED_TEMPLATE" });
    const receipt = (await db.query<{ id: string }>(`SELECT id FROM intake_mail_receipts WHERE receipt_id='unknown'`)).rows[0];
    await expect(replayMailReceipt(db, clock, "other", a.id, receipt.id)).rejects.toMatchObject({ code: "MAIL_ALIAS_NOT_FOUND" });
    expect(await replayMailReceipt(db, clock, "seller", a.id, receipt.id)).toEqual({ queued: true });
  });
  it("expired challenge cannot confirm verification; only the owner can read it", async () => {
    const a = await alias();
    await acceptTrustedSesReceipt(db, clock, queue(a.address), config);
    await dispatchMailJobs(db, clock, { readRawObject: async () => verification, submitObservation: async () => { throw Error(); } });
    const c = (await listMailSetup(db, clock, "seller"))[0].challenge!;
    expect(c.code).toBe("123456789");
    timestamp += 21 * 60000;
    expect((await listMailSetup(db, clock, "seller"))[0].challenge).toBeNull();
    await expect(acknowledgeMailVerification(db, clock, "seller", a.id, c.id)).rejects.toMatchObject({ code: "MAIL_CHALLENGE_EXPIRED" });
  });
  it("reclaims an expired lease, preserves provenance and deduplicates content across deliveries", async () => {
    const a = await verifiedAlias();
    await acceptTrustedSesReceipt(db, clock, queue(a.address, "sale"), config);
    await db.query(`UPDATE intake_mail_jobs SET state='RUNNING',attempts=1,lease_token='crashed',lease_expires_at=$1 WHERE receipt_id IN (SELECT id FROM intake_mail_receipts WHERE receipt_id='sale')`, [new Date(timestamp - 1).toISOString()]);
    const calls: any[] = [];
    const deps = { readRawObject: async () => message("Two blue widgets"), templates: [syntheticTemplate], submitObservation: async (_db: Database, _clock: unknown, actor: string, input: unknown, scope: unknown): Promise<any> => { calls.push({ actor, input, scope }); return { readiness: "READY", reasons: [] }; } };
    await dispatchMailJobs(db, clock, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ actor: "seller", input: { sourceKind: "FORWARDED_EMAIL", rawSourceRef: "s3://private-intake/raw/sale", items: [{ title: "Widget", quantity: 2, variant: "Blue" }] }, scope: { externalAccountReference: "verified-store", namespaceSource: "MARKETPLACE_API" } });
    expect((await listMailSetup(db, clock, "seller"))[0].state).toBe("READY");
    await acceptTrustedSesReceipt(db, clock, queue(a.address, "duplicate-content"), config);
    await dispatchMailJobs(db, clock, deps);
    expect(calls).toHaveLength(1);
    expect((await db.query(`SELECT id FROM intake_mail_receipts WHERE outcome='DUPLICATE'`)).rows).toHaveLength(1);
  });
  it("refuses to remap an alias when its connected account changes stores", async () => {
    const a = await verifiedAlias();
    await acceptTrustedSesReceipt(db, clock, queue(a.address, "sale"), config);
    let submitted = false;
    const deps = { readRawObject: async () => message("Sale"), templates: [syntheticTemplate], submitObservation: async (): Promise<any> => { submitted = true; return { readiness: "READY", reasons: [] }; } };
    await db.query(`UPDATE integration_connections SET external_account_reference='new-store' WHERE id='store'`);
    await dispatchMailJobs(db, clock, deps);
    expect(submitted).toBe(false);
    expect((await listMailSetup(db, clock, "seller"))[0]).toMatchObject({ store: "verified-store", lastErrorCode: "MAIL_STORE_SCOPE_CHANGED" });
    await expect(alias()).rejects.toMatchObject({ code: "MAIL_STORE_SCOPE_CHANGED" });
    await expect(db.query(`UPDATE intake_mail_aliases SET external_account_reference='new-store' WHERE id=$1`, [a.id])).rejects.toThrow("MAIL_ALIAS_SCOPE_IMMUTABLE");
  });
  it("retries fetch failures without losing receipt and blocks queued mail after alias revocation", async () => {
    const a = await verifiedAlias();
    await acceptTrustedSesReceipt(db, clock, queue(a.address, "sale"), config);
    await dispatchMailJobs(db, clock, { readRawObject: async () => { throw Error("sensitive raw data not logged"); }, submitObservation: async (): Promise<any> => { throw Error(); } });
    expect((await listMailSetup(db, clock, "seller"))[0].lastErrorCode).toBe("MAIL_PROCESSING_RETRY");
    timestamp += 60000;
    await revokeMailAlias(db, clock, "seller", a.id);
    let submitted = false;
    await dispatchMailJobs(db, clock, { readRawObject: async () => message("Sale"), templates: [syntheticTemplate], submitObservation: async (): Promise<any> => { submitted = true; return {}; } });
    expect(submitted).toBe(false);
    expect((await db.query(`SELECT id FROM intake_mail_receipts WHERE error_code='ALIAS_OR_STORE_INACTIVE'`)).rows).toHaveLength(1);
  });
});

describe("bounded inert MIME parser", () => {
  it("extracts UTF-8 multi-part text without executing or loading hostile HTML", () => {
    const raw = Buffer.from('From: seller@example.test\r\nSubject: Sale\r\nContent-Type: multipart/alternative; boundary="sample"\r\n\r\n--sample\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.from("2 × Blue widgets").toString("base64") + '\r\n--sample\r\nContent-Type: text/html\r\n\r\n<script>fetch("secret")</script><p>Widget</p><img src="https://track.test">\r\n--sample--');
    const result = parseMail(raw);
    expect(result.text).toBe("2 × Blue widgets");
    expect(result.htmlText).toContain("Widget");
    expect(result.htmlText).not.toMatch(/fetch|script|https/);
    expect(inertHtmlText("<svg>bad</svg>&lt;visible&gt;")).toContain("<visible>");
    expect(forwardingChallenge(parseMail(verification))?.code).toBe("123456789");
  });
  it.each([
    ["MESSAGE_TOO_LARGE", () => Buffer.alloc(MAIL_LIMITS.bytes + 1)],
    ["MALFORMED_HEADERS", () => Buffer.from("not MIME")],
    ["AMBIGUOUS_HEADERS", () => Buffer.from("From: one\r\nFrom: two\r\n\r\nbody")],
    ["MALFORMED_ENCODING", () => Buffer.from("Content-Transfer-Encoding: base64\r\n\r\n%%%")],
    ["MALFORMED_BOUNDARY", () => Buffer.from("Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nno close")],
  ])("rejects %s", (code, raw) => { expect(() => parseMail((raw as () => Buffer)())).toThrow(code as string); });
});
