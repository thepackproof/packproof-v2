import "fake-indexeddb/auto";
import { File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { preserveCapture, recoverCapture, captureQueueKey, resumeLocalRecordings, removePreservedLocalRecording } from "../capture-queue";
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
    getRecoveryStatus: vi.fn().mockResolvedValue({evidence:[{evidenceId:"evidence-1",status:"COMMITTED_PENDING_DURABILITY",receipt:null}]}),
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
  expect(f.api.initializeEvidenceUpload).toHaveBeenCalledTimes(2);
  expect(f.api.initializeEvidenceUpload.mock.calls[0]).toEqual(f.api.initializeEvidenceUpload.mock.calls[1]);
  expect(f.api.uploadResumable.mock.calls.map((c) => c[1])).toEqual(["evidence-1", "evidence-1"]);
  expect(await recoverCapture(f.key)).not.toBeNull();
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
  expect(await recoverCapture(f.key)).not.toBeNull();
});

it("allows explicit local cleanup only after a matching durable receipt and for the original account", async()=>{
  const f=fixture();
  await f.save();
  await expect(removePreservedLocalRecording(f.userId,f.key)).rejects.toThrow("Keep this local recording");
  f.api.getRecoveryStatus.mockResolvedValue({evidence:[{evidenceId:"evidence-1",status:"PRESERVED",receipt:{version:1}}],finalization:{status:"PRESERVED",receipt:{version:1}}} as never);
  await resumeLocalRecordings(f.api as unknown as PackProofApi,f.userId,()=>true);
  await expect(removePreservedLocalRecording("another-user",f.key)).rejects.toThrow();
  await removePreservedLocalRecording(f.userId,f.key);
  expect(await recoverCapture(f.key)).toBeNull();
});
it('persists discard intent through a lost response, then closes it without another upload',async()=>{
  const f=fixture();f.api.uploadResumable.mockRejectedValueOnce(new Error('offline'));await expect(f.save()).rejects.toThrow();
  const discard=vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValue(undefined);
  const api={...f.api,discardIncompleteEvidence:discard} as unknown as PackProofApi;
  const {discardLocalRecording,listRecoverableRecordings}=await import('../capture-queue');
  await expect(discardLocalRecording(api,f.userId,f.key)).rejects.toThrow('response lost');
  expect(await recoverCapture(f.key)).not.toBeNull();
  expect((await listRecoverableRecordings(f.userId,api)).find(row=>row.key===f.key)?.discardRequested).toBe(true);
  // A fresh module has no screen state or active promises to help it recover.
  vi.resetModules();const restarted=await import('../capture-queue');
  await restarted.resumeLocalRecordings(api,f.userId,()=>true);
  expect(discard).toHaveBeenCalledTimes(2);expect(discard).toHaveBeenLastCalledWith(f.proofId,'evidence-1');
  expect(f.api.uploadResumable).toHaveBeenCalledTimes(1);expect(await restarted.recoverCapture(f.key)).toBeNull();
});
it('server refusal to discard committed evidence retains its exact local original',async()=>{
  const f=fixture();await f.save();
  const api={...f.api,discardIncompleteEvidence:vi.fn().mockRejectedValue(Object.assign(new Error('Already committed'),{code:'EVIDENCE_ALREADY_COMMITTED',status:409}))} as unknown as PackProofApi;
  const {discardLocalRecording,listRecoverableRecordings}=await import('../capture-queue');
  await expect(discardLocalRecording(api,f.userId,f.key)).rejects.toThrow('Already committed');
  expect(await (await recoverCapture(f.key))!.arrayBuffer()).toEqual(await f.file.arrayBuffer());
  expect((await listRecoverableRecordings(f.userId,api)).find(row=>row.key===f.key)).toMatchObject({committed:true,discardRequested:false});
});
it('missing blob keeps identity and stops retrying while exposing incomplete-evidence cleanup',async()=>{
  const f=fixture();f.api.uploadResumable.mockRejectedValueOnce(new Error('offline'));await expect(f.save()).rejects.toThrow();
  await new Promise<void>((resolve,reject)=>{const open=indexedDB.open('packproof-capture',1);open.onsuccess=()=>{const db=open.result,tx=db.transaction('uploads','readwrite'),store=tx.objectStore('uploads'),read=store.get(f.key);read.onsuccess=()=>store.put({...read.result,file:undefined});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});
  const {listRecoverableRecordings}=await import('../capture-queue');
  await resumeLocalRecordings(f.api as unknown as PackProofApi,f.userId,()=>true);
  const item=(await listRecoverableRecordings(f.userId)).find(row=>row.key===f.key);
  expect(item).toMatchObject({evidenceId:'evidence-1',available:false,retryStopped:true});expect(f.api.uploadResumable).toHaveBeenCalledTimes(1);
});
