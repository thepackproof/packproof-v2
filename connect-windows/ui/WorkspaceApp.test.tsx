// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { WorkspaceApp } from "./WorkspaceApp";
import { bridgeFor, selected } from "./test-fixtures";
import type { ConnectStatus } from "./types";
import type { WorkspaceStatus } from "./workspace-types";

afterEach(cleanup);
const status=(ws:Partial<WorkspaceStatus>={}):ConnectStatus=>({...selected,workspace:{step:"order",phase:"draft",sources:[],...ws}});
const folder = {id:"source1",roles:["order" as const],folder:"C:\\Warehouse\\Sales reports",generation:1,state:"pending",
  recognition:{state:"recognized",message:"Found order records.",sample:{orderReference:"SO10482",eventId:"technical-event-000",sku:"A100"}}};

it("saves each step, displays only inspected business fields and reuses a selected folder",async()=>{
  let current=status();
  const bridge=bridgeFor(current,{
    getStatus:async()=>current,
    chooseWorkspaceFolder:vi.fn(async()=>current=status({sources:[folder]})),
    saveWorkspaceStep:vi.fn(async step=>current=status({...current.workspace,step})),
    reuseWorkspaceFolder:vi.fn(async()=>current=status({...current.workspace,sources:[{...folder,roles:["order","picking"]}]}))
  });
  render(<WorkspaceApp bridge={bridge}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Choose folder"}));
  expect(await screen.findByText("SO10482")).toBeVisible();
  expect(screen.queryByText("technical-event-000")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Next"}));
  await screen.findByRole("heading",{name:"Picking records"});
  fireEvent.click(screen.getByText("Use an existing location"));
  fireEvent.change(screen.getByRole("combobox",{name:"Records folder"}),{target:{value:"source1"}});
  fireEvent.click(screen.getByRole("button",{name:"Use this location"}));
  await waitFor(()=>expect(bridge.reuseWorkspaceFolder).toHaveBeenCalledWith("source1","picking"));
  expect(bridge.activateWorkspace).not.toHaveBeenCalled();
});

it("resumes the persisted review and displays a bounded cross-source local preview",async()=>{
  const current=status({step:"review",sources:[folder]});
  const bridge=bridgeFor(current,{workspaceDraftPreview:async()=>({scannedFiles:3,unresolved:1,limited:true,unreadFiles:0,
    examples:[{orderReference:"10482-A",source:"Sales",lines:[{lineId:"30",quantity:"1",unit:"EA",sku:"A100"}],packages:["PKG93"],
      events:[{kind:"label",source:"Shipping",fileName:"labels.json",occurredAt:"",shared:false}]}]})});
  render(<WorkspaceApp bridge={bridge}/>);
  expect(await screen.findByRole("heading",{name:"10482-A"})).toBeVisible();
  expect(screen.getByText("Label created")).toBeVisible();
  expect(screen.getByText(/record needs an order reference/)).toBeVisible();
  expect(bridge.activateWorkspace).not.toHaveBeenCalled();
});

it("keeps denied destinations blocked and requires explicit consent for a temporary outage", async()=>{
  const current=status({step:"activate",outputFolder:"C:\\Proofs",outputState:"denied",sources:[folder]});
  const app=render(<WorkspaceApp bridge={bridgeFor(current)}/>);
  expect(await screen.findByRole("button",{name:"Start collecting"})).toBeDisabled();
  app.unmount();
  const bridge=bridgeFor(status({...current.workspace,outputState:"unavailable"}));
  render(<WorkspaceApp bridge={bridge}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Start with local copies pending"}));
  await waitFor(()=>expect(bridge.activateWorkspace).toHaveBeenCalledWith(true));
});

it("resumes a browser approval and opens the committed revision from Overview",async()=>{
  let current=status({step:"activate",phase:"awaiting_approval",approvalPath:"/app/records/connect/approve?installationId=i"});
  const bridge=bridgeFor(current,{getStatus:async()=>current,workspaceOrderDetail:vi.fn(async()=>({proofId:"p1",orderReference:"SO10482",revision:3,lines:[{lineId:"20",sku:"A100",unit:"each",orderedQuantity:"3",shippedQuantity:"2",orderedShippedDiscrepancy:"1 EA more ordered than shipped"}],events:[],evidence:[]}))});
  render(<WorkspaceApp bridge={bridge}/>);
  await screen.findByRole("button",{name:"Open browser review"});
  current=status({phase:"active",step:"overview",orders:[{proofId:"p1",orderReference:"SO10482",revision:3}]});
  fireEvent.focus(window);
  await screen.findByRole("heading",{name:"Overview"});
  fireEvent.click(screen.getByRole("button",{name:/SO10482/}));
  expect(await screen.findByRole("heading",{name:"SO10482"})).toBeVisible();
  expect(screen.getByText("1 EA more ordered than shipped")).toBeVisible();
  expect(bridge.workspaceOrderDetail).toHaveBeenCalledWith("p1",3);
});

it("checks for browser approval as soon as Start collecting returns pending",async()=>{
  const draft=status({step:"activate",outputFolder:"C:\\Proofs",outputState:"ready",sources:[folder]});
  const awaiting=status({...draft.workspace,phase:"awaiting_approval",approvalPath:"/app/records/connect/approve?installationId=i"});
  const active=status({...draft.workspace,phase:"active",step:"overview"});
  const bridge=bridgeFor(draft,{
    activateWorkspace:vi.fn(async()=>awaiting),
    getWorkspaceStatus:vi.fn(async()=>active)
  });
  render(<WorkspaceApp bridge={bridge}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Start collecting"}));
  expect(await screen.findByRole("heading",{name:"Overview"})).toBeVisible();
  expect(bridge.getWorkspaceStatus).toHaveBeenCalledOnce();
});


it("asks which source owns an ambiguous reference before confirming a profile",async()=>{
  const current=status({sources:[{...folder,recognition:{state:"ambiguous",message:"Read picking references.",
    relatedChoices:[{role:"order",options:[{id:"sales1",displayName:"Sales East"},{id:"sales2",displayName:"Sales West"}]}]}}]});
  const bridge=bridgeFor(current);
  render(<WorkspaceApp bridge={bridge}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Sales West"}));
  await waitFor(()=>expect(bridge.chooseWorkspaceRelatedSource).toHaveBeenCalledWith("source1",1,"order","sales2"));
  expect(bridge.confirmWorkspaceOrderMap).not.toHaveBeenCalled();
});
it("adds the direct order system to the draft without requesting folder access",async()=>{
  const bridge=bridgeFor(status());
  render(<WorkspaceApp bridge={bridge}/>);
  fireEvent.click(await screen.findByText("Connect a system instead"));
  fireEvent.click(screen.getByRole("button",{name:"Connect PackProof Partner API"}));
  await waitFor(()=>expect(bridge.addWorkspaceDirectSource).toHaveBeenCalledWith(undefined));
  expect(bridge.chooseWorkspaceFolder).not.toHaveBeenCalled();
  expect(bridge.activateWorkspace).not.toHaveBeenCalled();
});
it("finds a committed order outside the recent list and opens the authorized revision",async()=>{
  const order={proofId:"older",revision:4,orderReference:"000120"};
  const current=status({phase:"active",step:"overview",orders:[]});
  const bridge=bridgeFor(current,{workspaceSearchOrders:vi.fn(async()=>[order]),workspaceOrderDetail:vi.fn(async()=>({...order,lines:[],evidence:[],events:[]}))});
  render(<WorkspaceApp bridge={bridge}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Orders"}));
  fireEvent.change(screen.getByRole("textbox",{name:"Order reference"}),{target:{value:"000120"}});
  fireEvent.click(screen.getByRole("button",{name:"Find order"}));
  fireEvent.click(await screen.findByRole("button",{name:/000120/}));
  expect(await screen.findByRole("heading",{name:"000120"})).toBeVisible();
  fireEvent.click(screen.getByRole("button",{name:"Open online order"}));
  expect(bridge.workspaceSearchOrders).toHaveBeenCalledWith("000120");
  expect(bridge.openWorkspaceOrder).toHaveBeenCalledWith("older",4);
});
