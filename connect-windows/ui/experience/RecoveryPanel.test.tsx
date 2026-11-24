// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { RecoveryPanel } from "./RecoveryPanel";
import { selected, bridgeFor } from "../test-fixtures";
import type { ConnectStatus } from "../types";
import type { WorkspaceSource } from "../workspace-types";

const ship:WorkspaceSource={id:"ship",folder:"C:\\Warehouse\\Shipping",roles:["shipping"],generation:4,
 state:"needs_attention",issue:"FOLDER_UNAVAILABLE",recognition:{state:"unavailable",message:"Folder unavailable"}};
const status=(canRead=true):ConnectStatus=>({
 ...selected,health:{...selected.health,queueCount:5,serviceOnline:true},
 proofOutput:{folder:"C:\\Proofs",state:"pending",pending:2},
 workspace:{phase:"active",step:"overview",viewKey:"site-a",canReadOrders:canRead,sources:[ship]},
});
afterEach(cleanup);
it("shows real pending queue and source errors, not mock recovery success",async()=>{
 const st=status();
 const bridge=bridgeFor(st,{getWorkspaceStatus:vi.fn(async()=>st)});
 const run=vi.fn(async(fn:()=>Promise<unknown>)=>{await fn();});
 const onSource=vi.fn();
 const onOutputSetup=vi.fn();
 render(<RecoveryPanel status={st} sources={[ship]} busy={false} run={run} bridge={bridge}
   onSource={onSource} onOutputSetup={onOutputSetup}/>);
 expect(screen.getByText("One connection needs attention")).toBeVisible();
 expect(screen.getByText("5")).toBeVisible();
 expect(screen.getByText("2")).toBeVisible();
 expect(screen.getByText("PackProof could not read this folder.")).toBeVisible();
 expect(screen.queryByText("Recovered successfully")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:/Shipping/}));
 expect(onSource).toHaveBeenCalledWith("ship");
 fireEvent.click(screen.getByRole("button",{name:"Review Proof folder"}));
 expect(onOutputSetup).toHaveBeenCalledOnce();
 fireEvent.click(screen.getByRole("button",{name:"Refresh actual status"}));
 await waitFor(()=>expect(bridge.getWorkspaceStatus).toHaveBeenCalledOnce());
});
it("redacts old facility source identity on access loss",()=>{
 const st=status(false);
 render(<RecoveryPanel status={st} sources={[ship]} busy={false} run={vi.fn()}
   bridge={bridgeFor(st)} onSource={vi.fn()} onOutputSetup={vi.fn()}/>);
 expect(screen.getByText("Source details are hidden while current access cannot be confirmed.")).toBeVisible();
 expect(screen.queryByText("Shipping")).toBeNull();
 expect(screen.queryByText("5")).toBeNull();
 expect(screen.queryByText("2")).toBeNull();
 expect(screen.queryByText("Output state: pending")).toBeNull();
 expect(screen.getByText(/Recovery counts and local output details are hidden/)).toBeVisible();
 expect(screen.queryByRole("button",{name:"Review Proof folder"})).toBeNull();
});

it("does not reveal cached source identity if hosted transport is incompatible or permission unknown",()=>{
 const granted=status();
 for(const candidate of [
   {...granted,transport:{...granted.transport!,state:"unsupported" as const}},
   {...granted,workspace:{...granted.workspace!,canReadOrders:undefined}},
 ]) {
   const view=render(<RecoveryPanel status={candidate} sources={[ship]} busy={false}
     run={vi.fn()} bridge={bridgeFor(candidate)} onSource={vi.fn()}/>);
   expect(screen.queryByText("Shipping")).toBeNull();
   expect(screen.getByText("Source details are hidden while current access cannot be confirmed.")).toBeVisible();
   view.unmount();
 }
});


it("removes recovery counters on scope, transport, or service loss and restores only with current authorization",()=>{
 const granted=status();
 const renderPanel=(value:ConnectStatus)=><RecoveryPanel status={value} sources={[ship]} busy={false}
   run={vi.fn()} bridge={bridgeFor(value)} onSource={vi.fn()}/>;
 const view=render(renderPanel(granted));
 expect(screen.getByText("5")).toBeVisible();
 expect(screen.getByText("2")).toBeVisible();
 for(const blocked of [
   status(false),
   {...granted,transport:{...granted.transport!,state:"forbidden" as const}},
   {...granted,health:{...granted.health,serviceOnline:false}},
 ]) {
   view.rerender(renderPanel(blocked));
   expect(screen.queryByText("5")).toBeNull();
   expect(screen.queryByText("2")).toBeNull();
   expect(screen.queryByText("Output state: pending")).toBeNull();
   expect(screen.getByText(/Recovery counts and local output details are hidden/)).toBeVisible();
   expect(screen.getByRole("button",{name:"Refresh actual status"})).toBeEnabled();
 }
 view.rerender(renderPanel(granted));
 expect(screen.getByText("5")).toBeVisible();
 expect(screen.getByText("2")).toBeVisible();
});


it("keeps every approved source reachable and prioritizes real file-lock recovery",()=>{
 const healthy:WorkspaceSource[]=Array.from({length:6},(_,i)=>({
   ...ship,id:"healthy-"+i,displayName:"Healthy system "+i,state:"active",issue:null,
   recognition:{state:"recognized",message:""}
 }));
 const locked:WorkspaceSource={...ship,id:"locked",displayName:"Locked order report",state:"active",issue:"SOURCE_BUSY",
   recognition:{state:"recognized",message:""}};
 const sources=[...healthy,locked];
 const st=status();
 const onSource=vi.fn();
 const panel=(value:ConnectStatus,rows:WorkspaceSource[])=> <RecoveryPanel status={value} sources={rows} busy={false}
   run={vi.fn()} bridge={bridgeFor(value)} onSource={onSource}/>;
 const view=render(panel(st,sources));
 expect(screen.getByText("6 collecting")).toBeVisible();
 expect(screen.getByText("One connection needs attention")).toBeVisible();
 const sourceButtons=screen.getAllByRole("button").filter(button=>button.classList.contains("eo-recovery-source"));
 expect(sourceButtons).toHaveLength(7);
 expect(sourceButtons[0]).toHaveTextContent("Locked order report");
 expect(sourceButtons[0]).toHaveTextContent("A warehouse file is in use.");
 fireEvent.click(sourceButtons[0]);
 expect(onSource).toHaveBeenCalledWith("locked");
 view.rerender(panel(st,[...healthy,{...locked,issue:null}]));
 expect(screen.getByText("7 collecting")).toBeVisible();
 expect(screen.queryByText(/A warehouse file is in use/)).toBeNull();
 view.rerender(panel(status(false),sources));
 expect(screen.queryByText("Locked order report")).toBeNull();
 expect(screen.queryByText("Healthy system 5")).toBeNull();
});
