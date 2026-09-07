import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { PackProofApi } from "../api/client";
import { stationContextFromProof } from "../../../mobile/src/packing-station/display";
import { canonicalProof } from "./fixtures";
import { saveStationCapture, stationCaptureKey, recoverStationCapture, resumeStationRecording, resumeLocalRecordings, listRecoverableRecordings, saveStageCapture, stageCaptureKey, recoverStageCapture, resumeStageRecording, listLocalRecordings, removePreservedLocalRecording } from "../capture-queue";
import type { RecoveryView } from "../components/PreservationStatus";
afterEach(() => vi.unstubAllGlobals());
async function station(committed = true, confirmed = true) {
  vi.stubGlobal("crypto", webcrypto);
  const userId = `seller-${crypto.randomUUID()}`;
  const proofId = crypto.randomUUID();
  const file = new NodeBlob(["recorded original bytes"], {type:"video/webm"}) as unknown as Blob;
  let proof = {...canonicalProof, proofId, status: committed ? "EVIDENCE_COMMITTED" : "READY_FOR_EVIDENCE", participationPolicy:"COUNTERPARTY_OPTIONAL" as const,
    participants:[{...canonicalProof.participants[0],userId,role:"SELLER"}], evidence:committed ? [{...canonicalProof.evidence[0],evidenceId:"video",validationStatus:"COMMITTED" as const}] : [], attestations:[]};
  const api = {
    getCapabilities:vi.fn(async()=>({schemaVersion:1,preservation:{receiptVersions:[1],durableReceiptsRequired:true}})),
    recoveryScope:"https://api.example.test", getProof:vi.fn(async()=>proof), completeCaptureSession:vi.fn(async()=>({})),
    initializeEvidenceUpload:vi.fn(async()=>({evidenceId:"video",upload:{method:"PUT",url:"/upload",headers:{}}})),
    uploadResumable:vi.fn(async()=>{}), commitEvidence:vi.fn(async()=>{proof={...proof,status:"EVIDENCE_COMMITTED",evidence:[{...canonicalProof.evidence[0],evidenceId:"video",validationStatus:"COMMITTED"}]};return{proof};}),
    createAttestation:vi.fn(async()=>({proof})), finalizeProof:vi.fn(async()=>{proof={...proof,status:"FINALIZED"};return{proof};}),
    getRecoveryStatus:vi.fn(async():Promise<RecoveryView>=>({proofId,evidence:[{evidenceId:"video",status:"PRESERVED",receipt:{version:1}}],declarations:[],finalization:{status:"PRESERVED",receipt:{version:1}}})),
    featureRequest:vi.fn(async()=>({})),
  };
  await saveStationCapture({key:stationCaptureKey(userId),userId,apiScope:api.recoveryScope,file,order:stationContextFromProof(proof),uploadKey:"original-key",evidenceId:committed?"video":undefined,finishConfirmed:confirmed,captureSessionId:"cap-original"});
  return { api, client:api as unknown as PackProofApi, userId,proofId,file,finalize:()=>{proof={...proof,status:"FINALIZED"};} };
}
it("lists an unconfirmed station original on every screen without submitting it",async()=>{
  const f=await station(false,false);await resumeLocalRecordings(f.client,f.userId,()=>true);
  expect(f.api.getProof).not.toHaveBeenCalled();expect(f.api.createAttestation).not.toHaveBeenCalled();
  expect(await listRecoverableRecordings(f.userId,f.client)).toEqual([expect.objectContaining({kind:"station",accepted:false,proofId:f.proofId})]);
  expect(await listRecoverableRecordings("another-user",f.client)).toEqual([]);
});
it("background retry recovers a lost finalization response and archives before clearing the same station intent",async()=>{
  const f=await station();f.api.finalizeProof.mockImplementationOnce(async()=>{f.finalize();throw new Error("response lost");});
  await expect(resumeStationRecording(f.client,f.userId,()=>true)).rejects.toThrow("response lost");
  expect((await recoverStationCapture(f.userId))?.uploadKey).toBe("original-key");
  await resumeStationRecording(f.client,f.userId,()=>true);
  expect(f.api.finalizeProof).toHaveBeenCalledTimes(1);expect(f.api.commitEvidence).not.toHaveBeenCalled();expect(f.api.uploadResumable).not.toHaveBeenCalled();
  expect(await recoverStationCapture(f.userId)).toBeNull();
  const archives=await listRecoverableRecordings(f.userId,f.client);
  expect(archives).toHaveLength(1);expect(archives[0]).toMatchObject({preserved:true,finalized:true});expect(await archives[0].file.text()).toBe("recorded original bytes");
});
it("foreground and background station work join one promise and preserve a single accepted operation",async()=>{
  const f=await station();const first=resumeStationRecording(f.client,f.userId,()=>true),second=resumeStationRecording(f.client,f.userId,()=>true);
  expect(first).toBe(second);await Promise.all([first,second]);
  expect(f.api.createAttestation).toHaveBeenCalledTimes(1);expect(f.api.finalizeProof).toHaveBeenCalledTimes(1);
});
it("explicit compatibility completion frees the station but keeps the exact local original and forbids cleanup",async()=>{
  const f=await station();
  f.api.getCapabilities.mockResolvedValue({schemaVersion:1,preservation:{receiptVersions:[1],durableReceiptsRequired:false}});
  f.api.getRecoveryStatus.mockResolvedValue({proofId:f.proofId,evidence:[{evidenceId:"video",status:"COMMITTED_PENDING_DURABILITY",receipt:null}],declarations:[],finalization:{status:"COMMITTED_PENDING_DURABILITY",receipt:null}});
  await resumeStationRecording(f.client,f.userId,()=>true);
  expect(await recoverStationCapture(f.userId)).toBeNull();
  const records=await listRecoverableRecordings(f.userId,f.client);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({submitted:true,preserved:false,finalized:false,committed:true});
  expect(await records[0].file.text()).toBe("recorded original bytes");
  await expect(removePreservedLocalRecording(f.userId,records[0].key,f.client)).rejects.toThrow("Keep this local recording");
  expect(f.api.finalizeProof).toHaveBeenCalledTimes(1);
});
it.each(["strict","unavailable","invalid"])("%s preservation policy cannot complete without receipts",async mode=>{
  const f=await station();
  f.api.getRecoveryStatus.mockResolvedValue({proofId:f.proofId,evidence:[{evidenceId:"video",status:"COMMITTED_PENDING_DURABILITY",receipt:null}],declarations:[],finalization:{status:"COMMITTED_PENDING_DURABILITY",receipt:null}});
  if(mode==="unavailable")f.api.getCapabilities.mockRejectedValue(new Error("offline"));
  if(mode==="invalid")f.api.getCapabilities.mockResolvedValue({schemaVersion:2,preservation:{receiptVersions:[1],durableReceiptsRequired:false}});
  await expect(resumeStationRecording(f.client,f.userId,()=>true)).rejects.toMatchObject({code:"PRESERVATION_PENDING"});
  expect(await recoverStationCapture(f.userId)).not.toBeNull();
  expect(await listLocalRecordings(f.userId)).toHaveLength(0);
});
it("an account change during upload prevents commit and retains original account bytes",async()=>{
  const f=await station(false);let active=true;
  f.api.uploadResumable.mockImplementationOnce(async()=>{active=false;});
  await expect(resumeStationRecording(f.client,f.userId,()=>active)).rejects.toMatchObject({code:"UNAUTHENTICATED"});
  expect(f.api.commitEvidence).not.toHaveBeenCalled();expect(await(await recoverStationCapture(f.userId))!.file.text()).toBe("recorded original bytes");
  expect(await recoverStationCapture("another-user")).toBeNull();
});
it("stage commit-response loss resumes that stage and cannot enter the ordinary root queue",async()=>{
  vi.stubGlobal("crypto",webcrypto);const userId=crypto.randomUUID(),proofId=crypto.randomUUID(),key=stageCaptureKey(userId,proofId,"RETURN_PACKING");
  const file=new NodeBlob(["return original"],{type:"video/webm"}) as unknown as Blob;
  await saveStageCapture({key,userId,proofId,apiScope:"https://api.example.test",stageId:"return-stage",captureSessionId:"cap-return",uploadKey:"stage-key",file,interrupted:false,bookmarks:[],submitRequested:true});
  let committed=false;
  const api={recoveryScope:"https://api.example.test",completeCaptureSession:vi.fn(async()=>{}),uploadObject:vi.fn(async()=>{}),featureRequest:vi.fn(),
    lifecycleRequest:vi.fn(async(_proof:string,path:string)=>{
      if(path==="")return{stages:[{stageId:"return-stage",evidence:committed?[{evidenceId:"return-video",committedAt:"2026-09-07"}]:[]}]};
      if(path.endsWith("/evidence"))return{evidenceId:"return-video",upload:{method:"PUT",url:"/upload",headers:{}}};
      if(path.endsWith("/commit")){committed=true;throw new Error("commit response lost");}return{};
    })};
  await expect(resumeStageRecording(api as unknown as PackProofApi,userId,key,()=>true)).rejects.toThrow("commit response lost");
  expect(await listLocalRecordings(userId)).toEqual([]);
  expect((await recoverStageCapture(key))?.evidenceId).toBe("return-video");
  await resumeStageRecording(api as unknown as PackProofApi,userId,key,()=>true);
  expect(api.uploadObject).toHaveBeenCalledTimes(1);expect(api.completeCaptureSession).toHaveBeenCalledTimes(1);expect(await recoverStageCapture(key)).toBeNull();
  expect((await listLocalRecordings(userId))[0]).toMatchObject({stageId:"return-stage",committed:true,preserved:false});
});
