import { Blob as NodeBlob } from "node:buffer";
import { createHash, webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PackProofApi } from "../api/client";
import { RecipientExportPanel } from "../components/RecipientExportPanel";

const proofId="proof_1",caseId="case_1",recoveryScope="seller_1";
const savedKey=`packproof.export.${recoveryScope}.seller-fixture.${proofId}.${caseId}`;
const bytes=Buffer.from("exact prepared image bytes");
const artifactSha256="a".repeat(64);
const profiles={profiles:[
  {id:"ebay-payment-dispute-us-v1",destination:"EBAY_PAYMENT_DISPUTE",network:"ANY",region:"US",version:"2026-09-07.1",reviewRequired:false},
  {id:"stripe-dispute-us-mastercard-v1",destination:"STRIPE_DISPUTE",network:"MASTERCARD",region:"US",version:"2026-09-07.1",reviewRequired:false},
  {id:"stripe-dispute-us-other-v1",destination:"STRIPE_DISPUTE",network:"OTHER",region:"US",version:"2026-09-07.1",reviewRequired:false},
]};
const ready={jobId:"rex_job1",proofId,caseId,state:"READY",artifactSha256,failureCode:null,approval:null,artifact:{
  files:[{name:"facts-1.jpg",contentType:"image/jpeg",byteSize:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")}],
  approvedNarrative:"Seller statement: the item was shown before packing.",gaps:["Address-match evidence is not established."]
}};
const approved={...ready,approval:{actorUserId:recoveryScope,artifactSha256,approvedAt:"2026-09-07T12:00:00.000Z"}};
const sources=[{evidenceId:"evidence_1",contentType:"video/mp4"}];
const previewPath="recipient-exports/rex_job1/files/0?preview=true";
const downloadPath="recipient-exports/rex_job1/download";

beforeEach(()=>{
  sessionStorage.clear();
  vi.stubGlobal("Blob",NodeBlob);
  vi.stubGlobal("crypto",webcrypto);
  Object.defineProperty(URL,"createObjectURL",{configurable:true,value:vi.fn(()=>"blob:prepared-file")});
  Object.defineProperty(URL,"revokeObjectURL",{configurable:true,value:vi.fn()});
  vi.spyOn(HTMLAnchorElement.prototype,"click").mockImplementation(()=>undefined);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

it("prepares selected source moments, verifies the exact preview, approves its digest, and re-downloads with the existing receipt",async()=>{
  const actions:string[]=[];
  const featureRequest=vi.fn(async(_id:string,path:string,method?:string,_body?:unknown)=>{
    if(path==="recipient-exports/profiles")return profiles;
    if(path==="recipient-exports"&&method==="POST"){actions.push("prepare");return {...ready,state:"QUEUED",artifact:null,artifactSha256:null};}
    if(path==="recipient-exports/rex_job1/approve"){actions.push("approve");return approved;}
    if(path==="recipient-exports/rex_job1")return ready;
    throw new Error(`Unexpected path ${path}`);
  });
  const featureDownload=vi.fn(async(_id:string,path:string)=>{
    actions.push(path===previewPath?"preview":"download");
    return new Blob([path===previewPath?bytes:"approved zip"],{type:path===previewPath?"image/jpeg":"application/zip"});
  });
  render(<RecipientExportPanel userId="seller-fixture" api={{recoveryScope,featureRequest,featureDownload} as unknown as PackProofApi} proofId={proofId} caseId={caseId} sources={sources}/>);
  await screen.findByRole("option",{name:"eBay payment dispute · images · US"});
  expect(screen.getByRole("option",{name:"Stripe dispute · Mastercard · PDF · US"})).toBeInTheDocument();
  expect(screen.getByRole("option",{name:"Stripe dispute · other networks · PDF · US"})).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Submission deadline from your case"),{target:{value:"2099-09-09T12:00"}});
  fireEvent.click(screen.getByRole("checkbox",{name:"I checked the current instructions and deadline for this case."}));
  fireEvent.click(screen.getByRole("button",{name:"Add a source frame"}));
  fireEvent.change(screen.getByLabelText("Time in recording (seconds)"),{target:{value:"1.25"}});
  fireEvent.change(screen.getByLabelText("Factual label"),{target:{value:"Item before packing"}});
  fireEvent.change(screen.getByLabelText("Supporting text · your statement"),{target:{value:ready.artifact.approvedNarrative}});
  fireEvent.click(screen.getByRole("button",{name:"Prepare exact files"}));
  await screen.findByRole("status");
  expect(featureRequest).toHaveBeenCalledWith(proofId,"recipient-exports","POST",{
    caseId,profileId:"ebay-payment-dispute-us-v1",frames:[{evidenceId:"evidence_1",offsetMs:1250,label:"Item before packing"}],
    narrative:ready.artifact.approvedNarrative,destinationDeadline:new Date("2099-09-09T12:00").toISOString(),destinationInstructionsReviewed:true,idempotencyKey:expect.any(String)
  });
  expect(sessionStorage.getItem(savedKey)).toBe("rex_job1");
  expect(featureDownload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Check preparation again"}));
  await screen.findByRole("img",{name:"Submission file 1: facts-1.jpg"});
  expect(featureDownload).toHaveBeenCalledWith(proofId,previewPath);
  expect(screen.getByRole("button",{name:"Approve and download files"})).toBeDisabled();
  expect(screen.getByText(ready.artifact.approvedNarrative,{selector:"p"})).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox",{name:"I reviewed these exact files and text; the relevant details are readable."}));
  fireEvent.click(screen.getByRole("button",{name:"Approve and download files"}));
  await waitFor(()=>expect(featureDownload).toHaveBeenCalledWith(proofId,downloadPath));
  expect(featureRequest).toHaveBeenCalledWith(proofId,"recipient-exports/rex_job1/approve","POST",{artifactSha256,legibilityConfirmed:true});
  expect(actions.indexOf("preview")).toBeLessThan(actions.indexOf("approve"));
  expect(actions.indexOf("approve")).toBeLessThan(actions.indexOf("download"));
  const repeat=await screen.findByRole("button",{name:"Download approved files again"});
  await waitFor(()=>expect(repeat).toBeEnabled());
  fireEvent.click(repeat);
  await waitFor(()=>expect(featureDownload.mock.calls.filter(c=>c[1]===downloadPath)).toHaveLength(2));
  expect(featureRequest.mock.calls.filter(c=>c[1].endsWith("/approve"))).toHaveLength(1);
  expect(screen.getByText(/has not submitted a dispute or confirmed portal acceptance/)).toBeInTheDocument();
});

it("recovers malformed format and saved-job responses without losing the case or silently approving",async()=>{
  let formatsReadable=false,jobReadable=false;
  sessionStorage.setItem(savedKey,"rex_job1");
  const featureRequest=vi.fn(async(_id:string,path:string)=>{
    if(path==="recipient-exports/profiles")return formatsReadable?profiles:{profiles:null};
    if(path==="recipient-exports/rex_job1")return jobReadable?ready:{...ready,artifact:{...ready.artifact,files:[ready.artifact.files[0],ready.artifact.files[0]]}};
    throw new Error("No mutation should occur during recovery");
  });
  const featureDownload=vi.fn(async()=>new Blob([bytes],{type:"image/jpeg"}));
  render(<RecipientExportPanel userId="seller-fixture" api={{recoveryScope,featureRequest,featureDownload} as unknown as PackProofApi} proofId={proofId} caseId={caseId} sources={sources}/>);
  await screen.findByRole("alert");
  expect(screen.getByRole("heading",{name:"Prepare submission files"})).toBeInTheDocument();
  expect(featureDownload).not.toHaveBeenCalled();
  expect(screen.queryByRole("button",{name:"Approve and download files"})).not.toBeInTheDocument();
  formatsReadable=true;
  fireEvent.click(screen.getByRole("button",{name:"Reload submission formats"}));
  await screen.findByRole("option",{name:"eBay payment dispute · images · US"});
  jobReadable=true;
  fireEvent.click(screen.getByRole("button",{name:"Check preparation again"}));
  await screen.findByRole("img",{name:"Submission file 1: facts-1.jpg"});
  expect(screen.getByRole("button",{name:"Approve and download files"})).toBeDisabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(sessionStorage.getItem(savedKey)).toBe("rex_job1");
  expect(featureRequest.mock.calls.every(c=>c[1]==="recipient-exports/profiles"||c[1]==="recipient-exports/rex_job1")).toBe(true);
});

it("blocks approval when downloaded preview bytes do not match the prepared file digest",async()=>{
  sessionStorage.setItem(savedKey,"rex_job1");
  const featureRequest=vi.fn(async(_id:string,path:string)=>path==="recipient-exports/profiles"?profiles:ready);
  const featureDownload=vi.fn(async()=>new Blob([Buffer.alloc(bytes.length,120)],{type:"image/jpeg"}));
  render(<RecipientExportPanel userId="seller-fixture" api={{recoveryScope,featureRequest,featureDownload} as unknown as PackProofApi} proofId={proofId} caseId={caseId} sources={sources}/>);
  expect(await screen.findByRole("alert")).toHaveTextContent("The preview does not match the prepared file.");
  fireEvent.click(screen.getByRole("checkbox",{name:"I reviewed these exact files and text; the relevant details are readable."}));
  expect(screen.getByRole("button",{name:"Approve and download files"})).toBeDisabled();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(featureRequest.mock.calls.some(c=>c[1].endsWith("/approve"))).toBe(false);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
