import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { auth, commitProofEvidence, createHarness, login, type TestHarness } from "./helpers.js";
import { revokeAccessLink } from "../src/domain/access-links.js";
import { sha256Hex } from "../src/hash.js";

let h: TestHarness, seller: string, other: string, proofId: string;
beforeAll(async () => {
  h = await createHarness(); seller = await login(h.app, "route-seller"); other = await login(h.app, "route-other");
  const transaction = await request(h.app).post("/transactions").set(auth(seller)).send({ itemTitle: "Camera", externalReference: "PRIVATE-ORDER", shipping: { carrier: "UPS", trackingNumber: "PRIVATE-TRACKING" } });
  const proof = await request(h.app).post(`/transactions/${transaction.body.transactionId}/proof`).set(auth(seller));
  proofId = proof.body.proofId;
});
afterAll(async () => { await h?.close(); });

describe("integrated signature release HTTP boundaries", () => {
  it("mounts new human routes behind authentication and participant checks", async () => {
    for (const endpoint of [`/proofs/${proofId}/signature`, `/proofs/${proofId}/disclosure/redactions`]) {
      expect((await request(h.app).get(endpoint)).status).toBe(401);
      expect((await request(h.app).get(endpoint).set(auth(other))).status).toBe(403);
      expect((await request(h.app).get(endpoint).set(auth(seller))).status).toBe(200);
    }
    expect((await request(h.app).post("/me/packing-relay")).status).toBe(401);
    expect((await request(h.app).post("/me/packing-relay").set(auth(seller))).status).toBe(201);
    expect((await request(h.app).post(`/proofs/${proofId}/capture-sessions`).set(auth(other)).send({ client: "WEB_CAMERA", idempotencyKey: "wrong-user" })).status).toBe(403);
  });
  it("passes a server-authorized capture through HTTP upload initialization", async () => {
    const media = await readFile(new URL("./fixtures/camera-recording.mp4", import.meta.url));
    const session = await request(h.app).post(`/proofs/${proofId}/capture-sessions`).set(auth(seller)).send({ client: "WEB_CAMERA", idempotencyKey: "route-camera" });
    expect(session.status).toBe(201);
    const complete = await request(h.app).post(`/proofs/${proofId}/capture-sessions/${session.body.id}/complete`).set(auth(seller)).send({ sha256: sha256Hex(media), byteSize: media.length, contentType: "video/mp4" });
    expect(complete.status).toBe(200);
    const upload = await request(h.app).post(`/proofs/${proofId}/evidence/uploads`).set(auth(seller)).send({ evidenceType: "FULFILLMENT_CAPTURE", contentType: "video/mp4", captureSessionId: session.body.id, idempotencyKey: "route-upload" });
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
  });
  it("exports only the authorized recipient view, honors media ranges, and rejects revoked export", async () => {
    const media = await commitProofEvidence(h, seller, proofId, { bytes: Buffer.from("authorized-source-bytes"), contentType: "image/jpeg", idempotencyKey: "scoped-export" });
    const input = { purpose: "CLAIMS_REVIEW", fields: ["status", "evidence"], media: [{ evidenceId: media.evidenceId, representation: "ORIGINAL" }], originalsReviewed: true };
    const preview = await request(h.app).post(`/proofs/${proofId}/disclosure/preview`).set(auth(seller)).send(input);
    expect(preview.status).toBe(200);
    const grant = await request(h.app).post(`/proofs/${proofId}/disclosure/grants`).set(auth(seller)).send({ ...input, previewHash: preview.body.disclosure.viewHash });
    expect(grant.status).toBe(201);
    const token = grant.body.token;
    const range = await request(h.app).get(`/public/proofs/${token}/evidence/${media.evidenceId}`).set("Range", "bytes=0-3");
    expect(range.status).toBe(206); expect(range.header["content-range"]).toBe("bytes 0-3/23");
    expect(range.header["cache-control"]).toContain("no-store");
    const exported = await request(h.app).get(`/public/proofs/${token}/package`).buffer(true).parse((response, done) => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("end", () => done(null, Buffer.concat(chunks)));
    });
    expect(exported.status).toBe(200); expect(exported.header["content-disposition"]).toContain(".zip");
    const bytes = exported.body as Buffer;
    expect(bytes.toString()).not.toContain("PRIVATE-"); expect(bytes.toString()).not.toContain("manifest.json");
    const dir = await mkdtemp(path.join(tmpdir(), "scoped-export-"));
    try {
      const file = path.join(dir, "view.zip"); await writeFile(file, bytes);
      const checked = spawnSync("python3", ["../verifier/verify.py", file], { encoding: "utf8" });
      expect(checked.status).toBe(2); expect(JSON.parse(checked.stdout)).toMatchObject({ status: "DISCLOSURE_ONLY", evidenceVerified: 0, includedDisclosureFilesChecked: 1, signatureVerified: false });
    } finally { await rm(dir, { recursive: true, force: true }); }
    await revokeAccessLink(h.db, h.clock, seller, proofId, grant.body.accessLinkId);
    expect((await request(h.app).get(`/public/proofs/${token}/package`)).status).toBe(404);
  });
});
