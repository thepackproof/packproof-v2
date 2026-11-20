// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import type { FacilityDraft, FacilityInputs } from "../guided-workflow-types";
import { bridgeFor, selected } from "../test-fixtures";
import type { ConnectStatus } from "../types";
import type { WorkspaceSource, WorkspaceBridge } from "../workspace-types";
import { Setup } from "./Setup";
import { assistantFields } from "./SetupAssistant";

afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const source: WorkspaceSource = { id: "packing", folder: "C:\\Exports", roles: ["packing"], generation: 1, state: "draft", transport: "folder",
  recognition: {state: "recognized", message: "Prepared carton records", fields: ["Shipped At", "SECRET_COMPANY_ID_124"], sample: {"Shipped At":"private-value"}}};
const initial: ConnectStatus = {...selected, installationId: "installation", workspace: {phase:"draft",step:"order",sources:[source],guidedSetupAvailable:true}};
const seed: FacilityDraft = {
  id:"72b7e000-8920-47c3-9af0-5e86ab4c92b7",revision:1,scopeKey:"facility",steps:[],
  examples:[],rules:[],excludedSourceIds:[],replay:null,
};

it("does not send source names, sample values, paths or unknown headings to the setup assistant", () => {
  expect(assistantFields([source],[]).fields).toEqual([
    {handle:"f1",label:"Shipped At",type:"datetime"}, {handle:"f2",label:"Other",type:"text"},
  ]);
  expect(assistantFields([source],[source.id]).fields).toEqual([]);
});

it("keeps offline edits limited to workflow notes and expectations", async () => {
  const status = {...initial,workspace:{...initial.workspace!,step:"review" as const, offlineDraftOnly:true}};
  const draft:FacilityDraft={...seed,notesOnly:true};
  const notes=vi.fn(async (_:number,changes:Pick<FacilityInputs,"steps"|"examples">)=>({...draft,...changes,revision:2}));
  const save=vi.fn();
  const bridge=bridgeFor(status,{getFacilityDraft:async()=>draft,saveFacilityNotes:notes,saveFacilityDraft:save});
  render(<Setup status={status} bridge={bridge} onStatus={()=>{}} onComplete={()=>{}} onSample={()=>{}}/>);
  expect(await screen.findByText("Working offline")).toBeVisible();
  expect(screen.queryByText("Get setup suggestions")).toBeNull();
  expect(screen.queryByRole("button",{name:"Find these orders"})).toBeNull();
  fireEvent.change(screen.getByLabelText("Order, carton or shipment reference"),{target:{value:"OFFLINE-1"}});
  fireEvent.click(screen.getByRole("button",{name:"Save draft"}));
  await waitFor(()=>expect(notes).toHaveBeenCalledTimes(1));
  expect(Object.keys(notes.mock.calls[0][1]).sort()).toEqual(["examples","steps"]);
  expect(save).not.toHaveBeenCalled();
});

it("records a review decision by original index only after a manual choice", async()=>{
  const review=vi.fn(async()=>{});
  const suggest=vi.fn(async()=>({revision:1,requestId:"review-request",suggestions:[
    {operation:"mark_unknown",step:"label",field:"f2",meaning:"unknown",reason:"missing_unit"},
    {operation:"ask_question",step:"label",field:"f1",meaning:"unknown",reason:"ambiguous_time"},
  ]}));
  vi.stubGlobal("packproofSetupAssistant",{suggest,review});
  const s={...initial,workspace:{...initial.workspace!,step:"packing" as const}};
  const save=vi.fn(async(_:number,changes:FacilityInputs)=>({...seed,...changes,revision:2}));
  const bridge=bridgeFor(s,{getFacilityDraft:async()=>seed,saveFacilityDraft:save});
  render(<Setup status={s} bridge={bridge} onStatus={()=>{}} onSample={()=>{}} onComplete={()=>{}}/>);
  fireEvent.click(await screen.findByText("Get setup suggestions"));
  expect(screen.getByRole("button",{name:"Suggest a setup choice"})).toBeDisabled();
  fireEvent.click(screen.getByLabelText("Allow this setup request"));
  fireEvent.click(screen.getByRole("button",{name:"Suggest a setup choice"}));
  fireEvent.click(await screen.findByRole("button",{name:"Dismiss"}));
  expect(review).toHaveBeenCalledTimes(1);
  expect(review.mock.calls[0]).toEqual([{draftId:seed.id,revision:1,requestId:"review-request",index:0,decision:"rejected"}]);
  expect(screen.getByRole("button",{name:"Use this meaning for this source"})).toBeDisabled();
  fireEvent.change(screen.getByLabelText("What does Shipped At mean in Exports?"),{target:{value:"label"}});
  expect(review).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button",{name:"Use this meaning for this source"}));
  expect(review.mock.calls[1]).toEqual([{draftId:seed.id,revision:1,requestId:"review-request",index:1,decision:"edited"}]);
  await waitFor(()=>expect(save).toHaveBeenCalledWith(1,expect.objectContaining({rules:[{sourceId:"packing",shippedAt:"label"}]})));
});

it("saves expectations before preview, requests discovery only on consent, and carries one source meaning into a reopened draft", async () => {
  let stored = seed;
  let status = initial;
  const save = vi.fn(async (expected:number, changes:FacilityInputs) => {
    expect(expected).toBe(stored.revision);
    return stored={...stored,...changes,revision:expected+1,replay:null};
  });
  const search = vi.fn(async () => []);
  const preview = vi.fn(async () => ({scannedFiles:2,unreadFiles:0,unresolved:0,limited:false,examples:[{
    orderReference:"stable.order",displayReference:"SO-10482",lookupReferences:["SO-10482","CTN-02"],source:"Orders",
    packages:["CTN-01","CTN-02"],lines:[],events:[],cartons:[
      {id:"CTN-01",namespace:"pack",status:"delivered",lastKind:"delivery"},
      {id:"CTN-02",namespace:"pack",status:"awaiting_evidence",lastKind:"label"},
    ],
  }]}));
  const bridge = bridgeFor(status, {
    getFacilityDraft:vi.fn(async () => stored),saveFacilityDraft:save,discoverWorkspaceFolders:search,
    workspaceDraftPreview:preview,saveWorkspaceStep:vi.fn(async step => status={...status,workspace:{...status.workspace!,step}}),
  });
  function Screen() {
    const [s, update] = useState(status);
    return <Setup status={s} bridge={bridge} onStatus={update} onSample={() => {}} onComplete={() => {}}/>;
  }
  const first = render(<Screen/>);
  fireEvent.change(await screen.findByLabelText("Order, carton or shipment reference"),{target:{value:"CTN-02"}});
  fireEvent.click(screen.getByRole("button",{name:"Find records"}));
  const searchButton = await screen.findByRole("button",{name:"Search export locations"});
  expect(search).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
  fireEvent.click(searchButton);
  await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText(/When does/),{target:{value:"label"}});
  fireEvent.click(screen.getByRole("button",{name:"Review a known order"}));
  fireEvent.click(await screen.findByRole("button",{name:"Find these orders"}));
  expect(await screen.findByText(/Awaiting delivery evidence · Label created/)).toBeVisible();
  expect(screen.getByText(/Delivery confirmed · Delivery recorded/)).toBeVisible();
  expect(stored.rules).toEqual([{sourceId:source.id,shippedAt:"label"}]);
  first.unmount(); render(<Screen/>);
  expect(await screen.findByLabelText("Order, carton or shipment reference")).toHaveValue("CTN-02");
  expect(screen.queryByText("CTN-01")).toBeNull();
});

it("edits a qualified packing source and previews a single record correction with undo", async () => {
  const packing: WorkspaceSource = {...source, recognition:{...source.recognition,packingSchema:"a".repeat(64),
    fields:["Tote Tag","Measured","Scale UOM"], sample:{"Tote Tag":"CTN-02","Scale UOM":"WP"}}};
  const orders: WorkspaceSource = {...source,id:"orders",folder:"C:\\Sales",roles:["order"]};
  let status: ConnectStatus={...initial,workspace:{...initial.workspace!,step:"packing",sources:[packing,orders]}};
  let d:FacilityDraft={...seed,examples:[{kind:"ordinary",reference:"SO-1",cartons:1,labelCount:null}]};
  const event={kind:"packing",fileName:"pack.csv",source:"Packing",sourceId:"packing",recordHash:"b".repeat(64),
    shared:false,occurredAt:"",locator:"row 2"};
  const bridge=bridgeFor(status,{
    getFacilityDraft:async()=>d, saveFacilityDraft:async (_,changes)=>d={...d,...changes,revision:d.revision+1},
    saveWorkspaceStep:async step=>status={...status,workspace:{...status.workspace!,step}},
    workspaceDraftPreview:async()=>({scannedFiles:2,unreadFiles:0,unresolved:0,limited:false,examples:["SO-1","SO-2"].map((order,i)=>({
      source:"Orders",orderReference:order,orderId:order,orderNamespace:"erp",lines:[],packages:[],events:i===0?[event]:[],
    }))}),
  });
  function Screen(){const [s,update]=useState(status);return <Setup status={s} bridge={bridge} onStatus={update} onSample={()=>{}} onComplete={()=>{}}/>;}
  render(<Screen/>);
  fireEvent.click(await screen.findByText("Clarify carton and weight fields"));
  fireEvent.change(screen.getByLabelText("Field that identifies this carton"),{target:{value:"Tote Tag"}});
  fireEvent.change(screen.getByLabelText("System that owns the order reference"),{target:{value:"orders"}});
  fireEvent.change(screen.getByLabelText("Recorded weight (optional)"),{target:{value:"Measured"}});
  fireEvent.change(screen.getByLabelText("Field containing the unit"),{target:{value:"Scale UOM"}});
  fireEvent.change(screen.getByLabelText("Meaning of this unit"),{target:{value:"lb"}});
  fireEvent.change(screen.getByLabelText("Exact unit text in this export"),{target:{value:"WP"}});
  fireEvent.click(screen.getByRole("button",{name:"Use this rule for this source"}));
  fireEvent.click(screen.getByRole("button",{name:"Review a known order"}));
  fireEvent.click(await screen.findByRole("button",{name:"Find these orders"}));
  expect(d.packing?.[0]).toMatchObject({cartonField:"Tote Tag",orderSourceId:"orders",unitField:"Scale UOM",unitValue:"WP",unit:"lb"});
  fireEvent.click(await screen.findByText("Correct a match"));
  fireEvent.change(screen.getByLabelText("Source record"),{target:{value:event.recordHash}});
  fireEvent.change(screen.getByLabelText("Move it to this order in the preview"),{target:{value:JSON.stringify(["erp","SO-2"])}});
  fireEvent.click(screen.getByRole("button",{name:"This record only"}));
  expect(await screen.findByText("Preview changes")).toBeVisible();
  await waitFor(()=>expect(d.recordEdits?.[0]).toMatchObject({fromId:"SO-1",toId:"SO-2",recordHash:event.recordHash,sourceId:"packing"}));
  fireEvent.click(screen.getByRole("button",{name:"Undo this correction"}));
  await waitFor(()=>expect(d.recordEdits).toEqual([]));
});

it("compares a source-wide edit on the same sampled originals and opens the contributing field and row", async () => {
  let d:FacilityDraft={...seed,examples:[{kind:"ordinary",reference:"SO-1",cartons:1,labelCount:null}]};
  let status:ConnectStatus={...initial,workspace:{...initial.workspace!,step:"packing"}};
  let changedOriginals=false;
  const preview=vi.fn<WorkspaceBridge["workspaceDraftPreview"]>(async compare=>{
    const kind=compare?.previous?"handoff":"label";
    return {sampleBasis:changedOriginals && compare?.previous?"different-original":"same-original",
      scannedFiles:2,unreadFiles:0,unresolved:0,limited:false,examples:["SO-1","SO-2"].map((id,i)=>({
        orderReference:id,orderId:id,orderNamespace:"erp",source:"Sales",packages:[],lines:[],
        events:i===1?[]:[{kind,occurredAt:"",source:"Dispatch",sourceId:source.id,fileName:"dispatch.csv",locator:"row 14",
          shared:false,entity:{namespace:"pack",type:"package",id:"CTN-02"},fieldLineage:{occurredAt:"Shipped At"},
          lines:[{sku:"VALVE",packedQuantity:"4",unit:"ea"}]}],
      }))};
  });
  const approve=vi.fn();
  const bridge=bridgeFor(status,{getFacilityDraft:async()=>d,saveFacilityDraft:async(revision,changes)=>d={...d,...changes,revision:revision+1},
    saveWorkspaceStep:async step=>status={...status,workspace:{...status.workspace!,step}},workspaceDraftPreview:preview,activateWorkspace:approve});
  function Screen(){const [s,update]=useState(status);return <Setup status={s} bridge={bridge} onStatus={update} onSample={()=>{}} onComplete={()=>{}}/>;}
  render(<Screen/>);
  fireEvent.change(await screen.findByLabelText(/When does/),{target:{value:"label"}});
  fireEvent.click(screen.getByRole("button",{name:"Compare this rule on sample orders"}));
  expect(await screen.findByText("1 of 2 sampled orders changed under this rule.")).toBeVisible();
  expect(screen.getByText(/Handed to carrier.*CTN-02/)).toBeVisible();
  expect(screen.getByText(/Label created.*CTN-02/)).toBeVisible();
  expect(preview.mock.calls.slice(0,2)).toEqual([[{draftId:seed.id,expectedRevision:2,previous:{rules:[],packing:[]}}],
    [{draftId:seed.id,expectedRevision:2}]]);
  changedOriginals=true;
  fireEvent.click(screen.getByRole("button",{name:"Compare this rule on sample orders"}));
  expect(await screen.findByText(/samples could not be held constant/)).toBeVisible();
  fireEvent.click(screen.getByRole("button",{name:"Review a known order"}));
  fireEvent.click(await screen.findByRole("button",{name:"Find these orders"}));
  fireEvent.click(await screen.findByRole("button",{name:/Label created.*row 14/}));
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(screen.getByText(/VALVE packed 4 ea/)).toBeVisible();
  fireEvent.click(screen.getByText("Fields used to interpret this record"));
  expect(screen.getByText("Shipped At")).toBeVisible();
  expect(approve).not.toHaveBeenCalled();
});
