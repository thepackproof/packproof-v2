import "fake-indexeddb/auto";
import {Blob as NodeBlob} from "node:buffer";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {StageRecorder} from "../components/StageRecorder";
import {PrivacySharePanel} from "../components/PrivacySharePanel";
import {SampleProof} from "../site/SampleProof";
import {clearStageCapture,stageCaptureKey,recoverStageCapture} from "../capture-queue";
import type {PackProofApi} from "../api/client";
import {canonicalProof} from "./fixtures";
const key=stageCaptureKey("user_seller","proof_stage_test","RECEIPT");
beforeEach(async()=>{await clearStageCapture(key);Object.defineProperty(URL,"createObjectURL",{configurable:true,value:vi.fn(()=>"blob:test")});Object.defineProperty(URL,"revokeObjectURL",{configurable:true,value:vi.fn()});});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it("binds a silent stage camera before its first frame and preserves the exact bytes before uploading",async()=>{
 const calls:string[]=[];vi.stubGlobal("Blob",NodeBlob);
 class Recorder {static isTypeSupported(){return true;}state="inactive";ondataavailable:((e:{data:Blob})=>void)|null=null;onstop:(()=>void)|null=null;start(){calls.push("first-frame");this.state="recording";}stop(){this.state="inactive";this.ondataavailable?.({data:new Blob(["captured camera bytes"],{type:"video/webm"})});this.onstop?.();}}
 vi.stubGlobal("MediaRecorder",Recorder);const camera=vi.fn(async(_constraints:MediaStreamConstraints)=>({getTracks:()=>[{stop:vi.fn()}]}));Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:camera}});
 const api={createCaptureSession:vi.fn(async()=>{calls.push("authorized");return{id:"capture-stage"};}),recoverCaptureSession:vi.fn(),completeCaptureSession:vi.fn(async()=>{calls.push("complete");}),lifecycleRequest:vi.fn(async(_id:string,path:string)=>{if(path==="/stages")return{stageId:"stage-1"};if(path.endsWith("/evidence")){calls.push("initialize");return{evidenceId:"media-1",upload:{url:"/upload/camera",method:"PUT",headers:{}}};}if(path.endsWith("/commit")){calls.push("commit");return{};}return{stages:[{stageId:"stage-1",evidence:[]}]};}),uploadObject:vi.fn(async(_t:unknown,file:Blob)=>{expect(await file.text()).toBe("captured camera bytes");expect((await recoverStageCapture(key))?.captureSessionId).toBe("capture-stage");calls.push("upload");}),featureRequest:vi.fn()};
 const saved=vi.fn(async()=>undefined);render(<StageRecorder api={api as unknown as PackProofApi} userId="user_seller" proofId="proof_stage_test" stageType="RECEIPT" onSaved={saved}/>);
 fireEvent.click(screen.getByRole("button",{name:"Record with this camera"}));await screen.findByRole("button",{name:"Stop recording and review"});expect(calls.slice(0,2)).toEqual(["authorized","first-frame"]);expect(camera.mock.calls[0][0]).toMatchObject({audio:false});
 fireEvent.click(screen.getByRole("button",{name:"Stop recording and review"}));fireEvent.click(await screen.findByRole("button",{name:"Save this stage recording"}));await waitFor(()=>expect(saved).toHaveBeenCalledTimes(1));expect(calls.slice(2)).toEqual(["complete","initialize","upload","commit"]);expect(api.recoverCaptureSession).not.toHaveBeenCalled();expect(api.completeCaptureSession).toHaveBeenCalledWith("proof_stage_test","capture-stage",expect.objectContaining({byteSize:21,contentType:"video/webm",interrupted:false}));expect(await recoverStageCapture(key)).toBeNull();
});
it("denied camera access creates no stage or capture session and offers retry",async()=>{
 Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:vi.fn(async()=>{throw new Error("Camera permission denied");})}});vi.stubGlobal("MediaRecorder",class{});const api={createCaptureSession:vi.fn(),lifecycleRequest:vi.fn()};render(<StageRecorder api={api as unknown as PackProofApi} userId="user_seller" proofId="proof_stage_test" stageType="RECEIPT" onSaved={async()=>{}}/>);fireEvent.click(screen.getByRole("button",{name:"Record with this camera"}));expect(await screen.findByRole("alert")).toHaveTextContent("Camera permission denied");expect(api.lifecycleRequest).not.toHaveBeenCalled();expect(api.createCaptureSession).not.toHaveBeenCalled();expect(screen.getByRole("button",{name:"Record with this camera"})).toBeEnabled();expect(document.querySelector('input[type="file"]')).toBeNull();
});
it("uses one shared Proof and requires the exact approved preview before creating a link",async()=>{
 const preview={proofId:canonicalProof.proofId,status:"FINALIZED",evidence:[],tracker:{itemTitle:"Shared item",headline:"Preserved record",milestones:[]},disclosure:{viewHash:"server-preview-hash",fields:["status","order","shipping","evidence"],scopeVersion:1,revocationNotice:"Saved copies cannot be recalled."}};
 const featureRequest=vi.fn(async(_id:string,path:string)=>path==="disclosure/preview"?preview:{accessLinkId:"reviewed-grant",url:"https://app.example/p/reviewed"});
 render(<PrivacySharePanel api={{featureRequest} as unknown as PackProofApi} proof={canonicalProof}/>);
 expect(screen.queryByText(/Who is this view for|Claims reviewer|Buyer receipt/)).not.toBeInTheDocument();
 expect(featureRequest.mock.calls.some(c=>c[1]==="disclosure/grants")).toBe(false);
 fireEvent.click(screen.getByRole("button",{name:"Preview Proof"}));
 await screen.findByRole("heading",{name:"Shared item"});
 expect(featureRequest).toHaveBeenCalledWith(canonicalProof.proofId,"disclosure/preview","POST",{purpose:"SHARED_PROOF"});
 expect(featureRequest.mock.calls.some(c=>c[1]==="disclosure/grants")).toBe(false);
 fireEvent.click(screen.getByRole("button",{name:"Create share link"}));
 await waitFor(()=>expect(featureRequest).toHaveBeenCalledWith(canonicalProof.proofId,"disclosure/grants","POST",expect.objectContaining({purpose:"SHARED_PROOF",originalsReviewed:true,previewHash:"server-preview-hash",expiresAt:expect.any(String)})));
 await waitFor(()=>expect(screen.getByRole("combobox",{name:"Link expires"})).toBeDisabled());
});
it("sample footage is playable, truthfully labeled, and case export waits for review",()=>{
 window.history.replaceState({},"","/sample");render(<SampleProof/>);expect(screen.getByText(/not recorded through PackProof/)).toBeInTheDocument();expect(document.querySelector("video")?.getAttribute("src")).toBe("/sample-packing.mp4");fireEvent.click(screen.getByRole("button",{name:"Case"}));expect(screen.getByRole("button",{name:"Download sample packet"})).toBeDisabled();fireEvent.click(screen.getByRole("checkbox",{name:"I reviewed this fictional sample packet"}));expect(screen.getByRole("button",{name:"Download sample packet"})).toBeEnabled();expect(screen.getAllByText(/No final seal, shipping label/).length).toBeGreaterThan(0);
});
