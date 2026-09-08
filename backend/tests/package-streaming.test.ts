import { afterAll, beforeAll, expect, it, vi } from "vitest";
import request from "supertest";
import { Readable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { auth, commitFulfillmentAndAttest, commitProofEvidence, createHarness, login, type TestHarness } from "./helpers.js";
import { createDisclosureGrant, previewDisclosure } from "../src/domain/disclosure.js";
import { revokeAccessLink } from "../src/domain/access-links.js";
import { exportDisclosurePackageStream } from "../src/domain/disclosure-package.js";
import { exportEvidencePackageStream } from "../src/domain/evidence-review.js";
import { finalizeProof } from "../src/domain/finalize.js";
import { collectSmallZip } from "../src/export/zip-stream.js";
import type { ObjectReference, ObjectStore } from "../src/s3/object-store.js";
import { appendProofSupplement } from "../src/domain/proof-supplements.js";
import type { ManifestSigner } from "../src/domain/manifest-signing.js";
import type { Database } from "../src/db/database.js";

let h: TestHarness, seller: string, proofId: string, evidenceId: string;
beforeAll(async () => {
  h = await createHarness(); seller = await login(h.app, "package-stream-seller");
  const tx = await request(h.app).post("/transactions").set(auth(seller)).send({ itemTitle: "Private package", externalReference: "PRIVATE-REFERENCE" });
  const p = await request(h.app).post(`/transactions/${tx.body.transactionId}/proof`).set(auth(seller)); proofId = p.body.proofId;
  const e = await commitProofEvidence(h, seller, proofId, { contentType: "image/jpeg", bytes: Buffer.alloc(512 * 1024, 120) }); evidenceId = e.evidenceId;
});
afterAll(async () => { await h?.close(); });
async function grant() {
  const input = { purpose: "CLAIMS_REVIEW", fields: ["status", "evidence"], media: [{ evidenceId, representation: "ORIGINAL" }], originalsReviewed: true, publicWebBaseUrl: "https://example.test" };
  const preview = await previewDisclosure(h.db, seller, proofId, input);
  const value = await createDisclosureGrant(h.db, h.clock, seller, proofId, { ...input, previewHash: preview.disclosure.viewHash });
  if (!("token" in value)) throw new Error("New token required"); return value;
}
async function offline(bytes: Buffer, expected?: string) {
  const folder = await mkdtemp(path.join(tmpdir(), "packproof-stream-review-"));
  try {
    const file = path.join(folder, "proof.zip"); await writeFile(file, bytes);
    const args = ["../verifier/verify.py", file]; if (expected) args.push("--expected-manifest-sha256", expected);
    const result = spawnSync("python3", args, { encoding: "utf8" }); return JSON.parse(result.stdout);
  } finally { await rm(folder, { recursive: true, force: true }); }
}
it("exports an independently readable scoped ZIP through exact-version streams and no whole-object get", async () => {
  const link = await grant(), get = vi.fn(async () => { throw new Error("Whole media read forbidden"); });
  const refs: Array<ObjectReference | undefined> = [];
  const store: ObjectStore = Object.assign(Object.create(h.objectStore), { get, getStream: async (key: string, reference?: ObjectReference) => { refs.push(reference); return h.objectStore.getStream!(key, reference); } });
  const bytes = await collectSmallZip(await exportDisclosurePackageStream(h.db, h.clock, store, link.token));
  expect(get).not.toHaveBeenCalled(); expect(refs.every(ref => !!ref?.versionId)).toBe(true);
  expect(bytes.toString()).not.toContain("PRIVATE-REFERENCE"); expect(bytes.toString()).not.toContain("objectKey");
  expect(await offline(bytes)).toMatchObject({ status: "DISCLOSURE_ONLY", includedDisclosureFilesChecked: 1, signatureVerified: false });
});
it("checks cumulative metadata limits before opening any source", async () => {
  const link = await grant(), getStream = vi.fn();
  const store: ObjectStore = Object.assign(Object.create(h.objectStore), { getStream });
  await expect(exportDisclosurePackageStream(h.db, h.clock, store, link.token, { maximumMediaBytes: 1024 })).rejects.toMatchObject({ code: "PACKAGE_TOO_LARGE" });
  expect(getStream).not.toHaveBeenCalled();
});
it.each(["REVOKE", "NARROW"])("aborts an in-flight scoped ZIP on %s and closes its source without an end directory", async action => {
  const link = await grant(); let pulled = 0, closed = false;
  const store: ObjectStore = Object.assign(Object.create(h.objectStore), {
    getStream: async (key: string, reference?: ObjectReference) => {
      const source = await h.objectStore.getStream!(key, reference); if (!source) return null;
      const body = Readable.from((async function* () {
        try {
          for await (const chunk of source.body) {
            if (++pulled === 2) {
              if (action === "REVOKE") await revokeAccessLink(h.db, h.clock, seller, proofId, link.accessLinkId);
              else {
                const narrow = { purpose: "CLAIMS_REVIEW", fields: ["status"], media: [], publicWebBaseUrl: "https://example.test" };
                const preview = await previewDisclosure(h.db, seller, proofId, narrow);
                await createDisclosureGrant(h.db, h.clock, seller, proofId, { ...narrow, accessLinkId: link.accessLinkId, previewHash: preview.disclosure.viewHash });
              }
            }
            yield chunk;
          }
        } finally { closed = true; source.body.destroy(); }
      })(), { objectMode: false, highWaterMark: 64 * 1024 });
      return { ...source, body };
    },
  });
  const chunks: Buffer[] = [];
  const consume = async () => { for await (const chunk of await exportDisclosurePackageStream(h.db, h.clock, store, link.token)) chunks.push(chunk); };
  await expect(consume()).rejects.toMatchObject({ code: action === "REVOKE" ? "ACCESS_LINK_REVOKED" : "INSUFFICIENT_SCOPE" });
  // Node destroys nested asynchronous iterators on the next turn; require the
  // storage iterator to finish promptly after the consumer sees the rejection.
  await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000, interval: 10 });
  expect(pulled).toBeLessThan(8);
  expect(Buffer.concat(chunks).includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(false);
});
it("streams canonical originals with their frozen version and retains explicit unavailable-source omissions", async () => {
  const tx = await request(h.app).post("/transactions").set(auth(seller)).send({ itemTitle: "Canonical original" });
  const p = await request(h.app).post(`/transactions/${tx.body.transactionId}/proof`).set(auth(seller)); const id = p.body.proofId;
  await commitFulfillmentAndAttest(h, seller, id); const frozen = await finalizeProof(h.db, h.clock, seller, id);
  const get = vi.fn(async () => { throw new Error("Whole media read forbidden"); }), refs: Array<ObjectReference | undefined> = [];
  const store: ObjectStore = Object.assign(Object.create(h.objectStore), { get, getStream: async (key: string, reference?: ObjectReference) => { refs.push(reference); return h.objectStore.getStream!(key, reference); } });
  const bytes = await collectSmallZip(await exportEvidencePackageStream(h.db, h.clock, store, seller, id));
  expect(get).not.toHaveBeenCalled(); expect(refs.every(ref => !!ref?.versionId)).toBe(true);
  expect(await offline(bytes, frozen.manifest.sha256)).toMatchObject({ status: "VERIFIED_INDEPENDENT_DIGEST", evidenceVerified: 1 });
  const unavailable: ObjectStore = Object.assign(Object.create(h.objectStore), { getStream: async () => null });
  const omitted = await collectSmallZip(await exportEvidencePackageStream(h.db, h.clock, unavailable, seller, id));
  expect(await offline(omitted, frozen.manifest.sha256)).toMatchObject({ status: "OMITTED_FILES", evidenceVerified: 0, completeMedia: false });
  const wrongVersion: ObjectStore = Object.assign(Object.create(h.objectStore), { getStream: async (key: string, reference?: ObjectReference) => { const data = await h.objectStore.getStream!(key, reference); return data ? { ...data, versionId: "different-version" } : null; } });
  await expect(collectSmallZip(await exportEvidencePackageStream(h.db, h.clock, wrongVersion, seller, id))).rejects.toMatchObject({ code: "EVIDENCE_INTEGRITY_FAILURE" });
});
it("freezes the signed supplement head at stream creation and preserves exact signed bytes in the indexed archive", async () => {
  const tx = await request(h.app).post("/transactions").set(auth(seller)).send({ itemTitle: "Supplement snapshot" });
  const p = await request(h.app).post(`/transactions/${tx.body.transactionId}/proof`).set(auth(seller)); const id = p.body.proofId;
  await commitFulfillmentAndAttest(h, seller, id); const frozen = await finalizeProof(h.db, h.clock, seller, id);
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signer: ManifestSigner = { signManifest: async input => ({ algorithm: "ECDSA_SHA_256", keyId: "ephemeral-export-test",
    signatureBase64: sign("sha256", Buffer.from(input.canonicalJson), pair.privateKey).toString("base64"), signedAt: h.clock.now().toISOString() }) };
  const first = await appendProofSupplement(h.db, h.clock, signer, seller, id, { operationId: "export-snapshot-first", kind: "CORRECTION", facts: { note: "First signed statement", measured: 0.000001 } });
  const stream = await exportEvidencePackageStream(h.db, h.clock, h.objectStore, seller, id);
  await appendProofSupplement(h.db, h.clock, signer, seller, id, { operationId: "export-snapshot-second", kind: "CORRECTION", facts: { note: "Later unseen statement" } });
  const folder = await mkdtemp(path.join(tmpdir(), "packproof-supplement-export-"));
  try {
    const file = path.join(folder, "proof.zip"); await writeFile(file, await collectSmallZip(stream));
    const result = spawnSync("python3", ["-c", "import zipfile,json,hashlib,sys; z=zipfile.ZipFile(sys.argv[1]); b=z.read('proof-supplements.json'); s=json.loads(b); p=json.loads(z.read('package.json')); a=json.loads(z.read('archive.json')); h=json.loads(z.read('integrity/hashes.json')); assert h['proof-supplements.json']==hashlib.sha256(b).hexdigest(); assert p['sources']['signedSupplements']==a['sources']['signedSupplements']; print(json.dumps({'snapshot':s,'source':p['sources']['signedSupplements']}))", file], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0); const extracted = JSON.parse(result.stdout);
    expect(extracted.snapshot).toMatchObject({ schema: "packproof.signed-supplement-snapshot.v1", proofId: id, coreManifestSha256: frozen.manifest.sha256, sequence: 1, sha256: first.sha256, supplements: [first] });
    expect(extracted.snapshot.supplements).toHaveLength(1);
    expect(extracted.snapshot.supplements[0].canonicalJson).toBe(first.canonicalJson);
    expect(extracted.source).toEqual({ path: "proof-supplements.json", sequence: 1, sha256: first.sha256, snapshotAt: extracted.snapshot.snapshotAt });
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it("records only prepared content when authorization fails before the ZIP end directory", async () => {
  const actor = await login(h.app, "archive-prepared-only-seller");
  const tx = await request(h.app).post("/transactions").set(auth(actor)).send({ itemTitle: "Interrupted archive" });
  const p = await request(h.app).post(`/transactions/${tx.body.transactionId}/proof`).set(auth(actor)); const id = p.body.proofId;
  await commitFulfillmentAndAttest(h, actor, id); await finalizeProof(h.db, h.clock, actor, id);
  let prepared = false;
  const db: Database = Object.assign(Object.create(h.db), {
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await h.db.query<T>(sql, params);
      if (sql.includes("INSERT INTO audit_events") && params?.[3] === "ARCHIVE_CONTENT_PREPARED") {
        prepared = true;
        await h.db.query("UPDATE users SET status='DISABLED' WHERE id=$1", [actor]);
      }
      return result;
    },
  });
  const chunks: Buffer[] = [];
  const consume = async () => { for await (const chunk of await exportEvidencePackageStream(db, h.clock, h.objectStore, actor, id)) chunks.push(chunk); };
  await expect(consume()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  expect(prepared).toBe(true);
  expect(Buffer.concat(chunks).includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(false);
  const events = (await h.db.query<{ event_type: string; event_data: unknown }>("SELECT event_type,event_data FROM audit_events WHERE proof_id=$1", [id])).rows;
  expect(events.filter(event => event.event_type === "PROOF_PACKAGE_EXPORTED")).toHaveLength(0);
  expect(events.filter(event => event.event_type === "ARCHIVE_CONTENT_PREPARED")).toEqual([
    expect.objectContaining({ event_data: expect.objectContaining({ archiveCompletion: "UNCONFIRMED", delivery: "UNCONFIRMED" }) }),
  ]);
});
