import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PackProofApi } from "../api/client";
import { StageRecorder } from "../components/StageRecorder";
import { saveStageCapture, stageCaptureKey } from "../capture-queue";
vi.mock("../components/ReturnAngleGuide",()=>({ReturnAngleGuide:()=>null}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it("changing accounts removes the prior stage review before any delayed recovery callback",async()=>{
  vi.stubGlobal("crypto",webcrypto);
  vi.stubGlobal("URL",class extends URL {static createObjectURL=()=>"blob:stage";static revokeObjectURL=()=>{};});
  const userId=crypto.randomUUID();const api={recoveryScope:"https://api.example.test"} as PackProofApi;
  await saveStageCapture({key:stageCaptureKey(userId,"proof-one","RETURN_PACKING"),userId,proofId:"proof-one",stageId:"stage-one",apiScope:api.recoveryScope,captureSessionId:"cap-one",uploadKey:"key-one",file:new NodeBlob(["old original"],{type:"video/webm"}) as unknown as Blob,interrupted:false,bookmarks:[]});
  const view=render(<StageRecorder api={api} userId={userId} proofId="proof-one" stageType="RETURN_PACKING" onSaved={async()=>{}}/>);
  await screen.findByRole("button",{name:"Save this stage recording"});
  view.rerender(<StageRecorder api={api} userId="other-account" proofId="other-proof" stageType="RETURN_PACKING" onSaved={async()=>{}}/>);
  expect(screen.queryByRole("button",{name:"Save this stage recording"})).toBeNull();
  expect(screen.queryByLabelText("Review captured stage recording")).toBeNull();
});
it("independent browser realms serialize journal comparison and writes with the same browser lock",async()=>{
  vi.stubGlobal("crypto",webcrypto);
  const tails=new Map<string,Promise<unknown>>();
  const request=vi.fn((name:string,_options:unknown,run:()=>Promise<unknown>)=>{
    const result=(tails.get(name)??Promise.resolve()).catch(()=>{}).then(run);tails.set(name,result);return result;
  });
  vi.stubGlobal("navigator",{locks:{request}});
  vi.resetModules();const first=await import("../capture-queue");
  vi.resetModules();const second=await import("../capture-queue");
  const userId=crypto.randomUUID(),key=first.stageCaptureKey(userId,"proof","RECEIPT");
  const base={key,userId,proofId:"proof",stageId:"stage",apiScope:"https://api.example.test",captureSessionId:"capture",file:new NodeBlob(["bytes"],{type:"video/webm"}) as unknown as Blob,interrupted:true,bookmarks:[]};
  const results=await Promise.allSettled([first.saveStageCapture({...base,uploadKey:"first"}),second.saveStageCapture({...base,uploadKey:"second"})]);
  expect(results.map(result=>result.status).sort()).toEqual(["fulfilled","rejected"]);
  expect((await first.recoverStageCapture(key))?.uploadKey).toBe("first");
  expect(request).toHaveBeenCalledWith(`packproof:journal:${key}`,{mode:"exclusive"},expect.any(Function));
});
