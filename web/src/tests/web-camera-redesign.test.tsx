import { Blob as NodeBlob } from "node:buffer";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PackProofApi } from "../api/client";
import { PackingStationScreen } from "../screens/PackingStationScreen";
import { canonicalProof } from "./fixtures";
import { recoverStationCapture, saveStationCapture, updateStationCaptureScans, resumeStationRecording } from "../capture-queue";
vi.mock("../capture-queue",()=>({recoverStationCapture:vi.fn(async()=>null),saveStationCapture:vi.fn(async()=>{}),updateStationCaptureScans:vi.fn(async()=>{}),resumeStationRecording:vi.fn(async()=>({completion:"FINALIZED"})),stationCaptureKey:(user:string)=>`${user}:station`}));
vi.mock("../components/RelayStationPanel",()=>({RelayStationPanel:()=>null}));
let recorder: Recorder;
class Recorder {
  static created=0;
  static isTypeSupported(){return true;}
  mimeType="video/webm";state="inactive";
  ondataavailable:((event:{data:Blob})=>void)|null=null;
  onstop:(()=>void)|null=null;
  onerror:(()=>void)|null=null;
  constructor(){recorder=this;Recorder.created+=1;}
  start=vi.fn(()=>{this.state="recording";});
  stop=vi.fn(()=>{this.state="inactive";this.ondataavailable?.({data:new Blob(["original packing bytes"],{type:this.mimeType})});queueMicrotask(()=>this.onstop?.());});
}
function api(){
  return {recoveryScope:"https://one.test",getProof:vi.fn(async()=>({...canonicalProof,status:"READY_FOR_EVIDENCE",evidence:[],attestations:[],participationPolicy:"COUNTERPARTY_OPTIONAL"})),
    getCapabilities:vi.fn(async()=>({schemaVersion:1,capture:{protocolVersions:[1],maxBytes:1000000,maxDurationSeconds:120,maxActiveUploads:2},preservation:{receiptVersions:[1],durableReceiptsRequired:true},shippingReview:{requiredForObservedConflicts:true,noLabelAllowed:true},correctionPolicy:{importedFactsReadOnly:true,captureBindingLocksManualDetails:true},sellerAttestation:{contextBindingVersion:1}})),
    featureRequest:vi.fn(async()=>({cancelled:true})),createCaptureSession:vi.fn(async()=>({id:"capture-one",state:"ISSUED"})),getCaptureShippingReview:vi.fn(async()=>({currentTrackingNumber:null,reviewRequired:false,observations:[]})),bindCaptureShipping:vi.fn(async()=>({status:"BOUND",trackingNumber:"9400111899223344556677"}))};
}
beforeEach(()=>{
 Recorder.created=0;vi.clearAllMocks();vi.mocked(recoverStationCapture).mockResolvedValue(null);
 vi.stubGlobal("Blob",NodeBlob);vi.stubGlobal("MediaRecorder",Recorder);
 Object.defineProperty(URL,"createObjectURL",{configurable:true,value:()=>"blob:recording"});Object.defineProperty(URL,"revokeObjectURL",{configurable:true,value:()=>{}});
 Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:vi.fn(async()=>({getTracks:()=>[{stop:vi.fn()}]}))}});
 vi.spyOn(HTMLMediaElement.prototype,"play").mockResolvedValue(undefined);
 Object.defineProperty(HTMLVideoElement.prototype,"videoWidth",{configurable:true,get:()=>640});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function open(client=api()){
 const view=render(<PackingStationScreen api={client as unknown as PackProofApi} userId="user_seller" initialProofId={canonicalProof.proofId} queue={[]} error={null} onAuthExpired={()=>{}}/>);
 const start=await screen.findByRole("button",{name:"Record packing"});await waitFor(()=>expect(start).toBeEnabled());return{client,start,...view};
}
it("opens a preview without recording and stops once into an unsubmitted review",async()=>{
 const {client,start}=await open();expect(client.createCaptureSession).not.toHaveBeenCalled();
 fireEvent.click(start);await screen.findByRole("button",{name:"Finish recording"});
 await userEvent.dblClick(screen.getByRole("button",{name:"Finish recording"}));
 expect(await screen.findByLabelText("Recorded packing video")).toBeInTheDocument();expect(recorder.stop).toHaveBeenCalledTimes(1);
 expect(vi.mocked(saveStationCapture).mock.calls.at(-1)![0].finishConfirmed).toBe(false);
 expect(resumeStationRecording).not.toHaveBeenCalled();expect(screen.getByRole("button",{name:"Confirm and submit"})).toBeDisabled();
 await userEvent.click(screen.getByRole("checkbox"));await waitFor(()=>expect(screen.getByRole("button",{name:"Confirm and submit"})).toBeEnabled());
 await userEvent.click(screen.getByRole("button",{name:"Confirm and submit"}));expect(await screen.findByRole("heading",{name:"Proof saved"})).toBeInTheDocument();
 expect(resumeStationRecording).toHaveBeenCalledTimes(1);
});
it("preserves and reviews final bytes while a barcode request remains in flight",async()=>{
 const client=api();let resolve!:(value:{status:string;trackingNumber:string})=>void;
 client.bindCaptureShipping.mockImplementation(()=>new Promise(done=>{resolve=done;}));
 vi.stubGlobal("BarcodeDetector",class{async detect(){return[{rawValue:"9400111899223344556677",format:"code_128"}];}});
 const {start}=await open(client);fireEvent.click(start);
 await waitFor(()=>expect(client.bindCaptureShipping).toHaveBeenCalledTimes(1),{timeout:2500});
 await userEvent.click(screen.getByRole("button",{name:"Finish recording"}));
 expect(await screen.findByLabelText("Recorded packing video")).toBeInTheDocument();
 const local=vi.mocked(saveStationCapture).mock.calls.at(-1)![0];expect(await local.file.text()).toBe("original packing bytes");expect(local.shippingScans?.[0].status).toBe("QUEUED");
 await userEvent.click(screen.getByRole("checkbox"));expect(screen.getByRole("button",{name:"Confirm and submit"})).toBeDisabled();
 resolve({status:"BOUND",trackingNumber:"9400111899223344556677"});
 await waitFor(()=>expect(screen.getByRole("button",{name:"Confirm and submit"})).toBeEnabled());
 expect(updateStationCaptureScans).toHaveBeenLastCalledWith("user_seller","capture-one",[expect.objectContaining({status:"BOUND"})]);
});
it("blocks unresolved label conflicts while retaining the original",async()=>{
 const client=api();client.getCaptureShippingReview.mockResolvedValue({currentTrackingNumber:null,reviewRequired:true,observations:[]});
 const {start}=await open(client);fireEvent.click(start);await userEvent.click(await screen.findByRole("button",{name:"Finish recording"}));
 await screen.findByLabelText("Recorded packing video");await userEvent.click(screen.getByRole("checkbox"));
 expect(screen.getByRole("button",{name:"Confirm and submit"})).toBeDisabled();expect(resumeStationRecording).not.toHaveBeenCalled();
});
it("preserves the specific preflight failure before requesting camera permission",async()=>{
 const client=api();client.getCapabilities.mockRejectedValue(new Error("Update PackProof before recording."));
 render(<PackingStationScreen api={client as unknown as PackProofApi} userId="user_seller" initialProofId={canonicalProof.proofId} queue={[]} error={null} onAuthExpired={()=>{}}/>);
 expect(await screen.findByRole("alert")).toHaveTextContent("Update PackProof before recording.");expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
});

it("never starts recording if navigation leaves while the capture session is being issued",async()=>{
 const client=api();let issue!:(value:{id:string;state:string})=>void;
 client.createCaptureSession.mockImplementation(()=>new Promise(resolve=>{issue=resolve;}));
 const {start,unmount}=await open(client);fireEvent.click(start);
 await waitFor(()=>expect(client.createCaptureSession).toHaveBeenCalledTimes(1));unmount();
 issue({id:"late-unused-session",state:"ISSUED"});
 await waitFor(()=>expect(client.featureRequest).toHaveBeenCalledWith(canonicalProof.proofId,"capture-sessions/late-unused-session/cancel","POST",{}));
 expect(Recorder.created).toBe(0);expect(saveStationCapture).not.toHaveBeenCalled();
});
