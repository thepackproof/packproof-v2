// @vitest-environment jsdom
import {afterEach,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {Workspace} from "./Workspace";
import {bridgeFor,selected} from "../test-fixtures";
import type {ConnectStatus} from "../types";
import type {WorkspaceStatus} from "../workspace-types";
const status=(values:Partial<WorkspaceStatus>={}):ConnectStatus=>({...selected,workspace:{phase:"active",step:"overview",canReadOrders:true,viewKey:"first",sources:[],...values}});
afterEach(cleanup);
it("opens an authorized review from outside the recent page and pages older orders",async()=>{
  const old={proofId:"older",revision:7,orderReference:"O-31",customerName:"North Supply",issue:"2 EA more loaded than acknowledged"};
  const s=status({totalOrders:35,updatedLast24Hours:3,orders:[],nextBefore:170});
  const b=bridgeFor(s,{workspaceAttention:vi.fn(async()=>({items:[],hasMore:false,orderIssues:[old],orderIssueCount:1})),workspaceOrderPage:vi.fn(async()=>({orders:[old],nextBefore:null}))});
  const props={status:s,bridge:b,onStatus:vi.fn(),onProof:vi.fn(),onSection:vi.fn()};
  const app=render(<Workspace {...props} section="attention"/>);
  fireEvent.click(await screen.findByRole("button",{name:/2 EA more loaded/}));
  expect(props.onProof).toHaveBeenCalledWith("older",7);
  app.rerender(<Workspace {...props} section="orders"/>);
  fireEvent.click(screen.getByRole("button",{name:/Load earlier orders/}));
  fireEvent.click(await screen.findByRole("button",{name:/O-31/}));
  expect(b.workspaceOrderPage).toHaveBeenCalledWith(170);expect(props.onProof).toHaveBeenCalledTimes(2);
  app.rerender(<Workspace {...props} status={status({canReadOrders:false})} section="orders"/>);expect(screen.queryByText("North Supply")).toBeNull();
});
it("repairs the selected source by identity and generation without claiming a cancelled selection succeeded",async()=>{
  const s=status({sources:[{id:"ship",folder:"C:\\Warehouse\\Shipping",roles:["shipping"],generation:3,state:"needs_attention",recognition:{state:"unavailable",message:"This folder is unavailable."}}]});
  const b=bridgeFor(s,{replaceWorkspaceFolder:vi.fn(async()=>s)});
  const props={status:s,bridge:b,onStatus:vi.fn(),onProof:vi.fn(),onSection:vi.fn(),onBusyChange:vi.fn()};
  render(<Workspace {...props} section="connections"/>);
  fireEvent.click(screen.getByRole("button",{name:/Fix connection/}));fireEvent.click(screen.getByRole("button",{name:/Choose a readable folder/}));
  await waitFor(()=>expect(props.onStatus).toHaveBeenCalledWith(s));expect(b.replaceWorkspaceFolder).toHaveBeenCalledWith("ship",3);
  expect(screen.getByRole("heading",{name:/Reconnect your shipping folder/})).toBeVisible();expect(screen.queryByText("Connected")).toBeNull();
});
