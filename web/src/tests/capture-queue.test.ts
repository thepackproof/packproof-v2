import "fake-indexeddb/auto";
import { File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { preserveCapture, recoverCapture, captureQueueKey } from "../capture-queue";
import type { PackProofApi } from "../api/client";
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  vi.stubGlobal("crypto", webcrypto);
  const proofId = crypto.randomUUID(),
    userId = "synthetic-seller";
  const file = new NodeFile(["packing recording"], "packing.mp4", {
    type: "video/mp4",
  }) as unknown as File;
  const api = {
    getProof: vi.fn().mockResolvedValue({ evidence: [] }),
    initializeEvidenceUpload: vi.fn().mockResolvedValue({ evidenceId: "evidence-1" }),
    uploadResumable: vi.fn().mockResolvedValue(undefined),
    commitEvidence: vi.fn().mockResolvedValue({}),
    discardUpload: vi.fn().mockResolvedValue(undefined),
  };
  const save = () =>
    preserveCapture(
      api as unknown as PackProofApi,
      userId,
      proofId,
      "PACKING",
      file,
      "FULFILLMENT_CAPTURE",
      () => {},
    );
  return {
    api,
    userId,
    proofId,
    file,
    save,
    key: captureQueueKey(userId, proofId, "PACKING"),
  };
}
it("recovers local bytes after a failed upload and retries the original evidence identity", async () => {
  const f = fixture();
  f.api.uploadResumable.mockRejectedValueOnce(new Error("Connection lost"));
  await expect(f.save()).rejects.toThrow("Connection lost");
  const recovered = await recoverCapture(f.key);
  expect(await recovered!.arrayBuffer()).toEqual(await f.file.arrayBuffer());
  expect(await recoverCapture(captureQueueKey("another-user", f.proofId, "PACKING"))).toBeNull();
  expect(await f.save()).toBe("evidence-1");
  expect(f.api.initializeEvidenceUpload).toHaveBeenCalledTimes(1);
  expect(f.api.uploadResumable.mock.calls.map((c) => c[1])).toEqual(["evidence-1", "evidence-1"]);
  expect(await recoverCapture(f.key)).toBeNull();
});
it("recovers a lost commit response without uploading or committing the recording twice", async () => {
  const f = fixture();
  f.api.commitEvidence.mockImplementationOnce(async () => {
    f.api.getProof.mockResolvedValue({
      evidence: [{ evidenceId: "evidence-1", validationStatus: "COMMITTED" }],
    });
    throw new Error("Response lost");
  });
  await expect(f.save()).rejects.toThrow("Response lost");
  expect(await f.save()).toBe("evidence-1");
  expect(f.api.uploadResumable).toHaveBeenCalledTimes(1);
  expect(f.api.commitEvidence).toHaveBeenCalledTimes(1);
  expect(f.api.discardUpload).not.toHaveBeenCalled();
  expect(await recoverCapture(f.key)).toBeNull();
});
