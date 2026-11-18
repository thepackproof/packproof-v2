// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { bridgeFor, selected } from "../test-fixtures";
import type { ConnectStatus } from "../types";
import type { DraftPreview, WorkspaceBridge, WorkspaceSource, WorkspaceStatus } from "../workspace-types";
import { Setup } from "./Setup";

afterEach(cleanup);
const folder:WorkspaceSource={id:"orders",folder:"C:\\Sales",roles:["order"],generation:1,state:"pending",recognition:{state:"recognized",message:"Order records found."}};
const init=(workspace:Partial<WorkspaceStatus>={}):ConnectStatus=>({...selected,workspace:{phase:"draft",step:"order",sources:[],...workspace}});
const example:DraftPreview["examples"][number]={orderReference:"REAL-37",source:"Sales",lines:[{lineId:"4",sku:"BV45",unit:"EA",quantity:"12"}],packages:[],events:[{kind:"order",source:"Sales",fileName:"sales.csv",occurredAt:"",shared:false}]};
const preview=()=>Promise.resolve({limited:false,unresolved:0,unreadFiles:0,scannedFiles:1,examples:[example]});

function Harness({initial,bridge,openDraft}:{initial:ConnectStatus;bridge:WorkspaceBridge;openDraft?:(e:typeof example)=>void}) {
  const [status,setStatus]=useState(initial);
  return <Setup status={status} onStatus={setStatus} bridge={bridge} onComplete={()=>{}} onSample={()=>{}} onOpenDraftProof={openDraft}/>;
}

it("takes a real selected source through local proof, destination selection and browser approval",async()=>{
  let state=init();
  const update=(changes:Partial<WorkspaceStatus>)=>state={...state,workspace:{...state.workspace!,...changes}};
  const bridge=bridgeFor(state,{
    chooseWorkspaceFolder:vi.fn(async()=>update({sources:[folder]})),workspaceDraftPreview:vi.fn(preview),
    saveWorkspaceStep:vi.fn(async step=>update({step})),chooseWorkspaceOutput:vi.fn(async()=>update({outputFolder:"C:\\Proofs",outputState:"ready"})),
    activateWorkspace:vi.fn(async()=>update({step:"activate",phase:"awaiting_approval",approvalPath:"/approval"}))
  });
  const openDraft=vi.fn();
  render(<Harness initial={state} bridge={bridge} openDraft={openDraft}/>);
  fireEvent.click(screen.getByRole("button",{name:"Connect my records"}));
  fireEvent.click(screen.getByRole("button",{name:/In a spreadsheet or folder/}));
  fireEvent.click(screen.getByRole("button",{name:/Choose a folder myself/}));
  fireEvent.click(await screen.findByRole("button",{name:"Open order REAL-37"}));
  expect(await screen.findByRole("heading",{name:"REAL-37"})).toBeVisible();
  fireEvent.click(screen.getByRole("button",{name:/Open the full proof/}));
  expect(openDraft).toHaveBeenCalledWith(example);
  expect(screen.queryByText("North Ridge Supply")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Turn on automatic updates"}));
  expect(await screen.findByRole("button",{name:"Continue"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"Choose proof folder"}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"Continue"})).toBeEnabled());
  fireEvent.click(screen.getByRole("button",{name:"Continue"}));
  fireEvent.click(await screen.findByRole("button",{name:"Review in browser"}));
  expect(await screen.findByRole("button",{name:"Open browser review"})).toBeVisible();
  expect(bridge.activateWorkspace).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Automatic updates are on.")).toBeNull();
});

it("requires permission for unavailable output and never starts collection for a denied destination",async()=>{
  const denied=init({step:"activate",sources:[folder],outputFolder:"C:\\Proofs",outputState:"denied"});
  const {unmount}=render(<Harness initial={denied} bridge={bridgeFor(denied)}/>);
  expect(screen.getByRole("button",{name:"Review in browser"})).toBeDisabled();unmount();
  const pending=init({...denied.workspace,outputState:"unavailable"});
  const bridge=bridgeFor(pending);render(<Harness initial={pending} bridge={bridge}/>);
  fireEvent.click(screen.getByRole("button",{name:"Start with local copies pending"}));
  await waitFor(()=>expect(bridge.activateWorkspace).toHaveBeenCalledWith(true));
});

it("keeps software exports distinct from direct partner integration",async()=>{
  const initial=init();const bridge=bridgeFor(initial);
  render(<Harness initial={initial} bridge={bridge}/>);
  fireEvent.click(screen.getByRole("button",{name:"Connect my records"}));
  fireEvent.click(screen.getByRole("button",{name:/In our order software/}));
  fireEvent.click(screen.getByRole("button",{name:/Microsoft Dynamics 365/}));
  expect(screen.getByRole("heading",{name:"Connect your Microsoft Dynamics 365 orders."})).toBeVisible();
  expect(bridge.addWorkspaceDirectSource).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:/Choose my export folder/}));
  await waitFor(()=>expect(bridge.chooseWorkspaceFolder).toHaveBeenCalledWith("order"));
  expect(screen.queryByText("Automatic updates are on.")).toBeNull();
});
