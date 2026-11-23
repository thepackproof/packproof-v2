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
 render(<RecoveryPanel status={st} sources={[ship]} busy={false} run={run} bridge={bridge} onSource={onSource}/>);
 expect(screen.getByText("One connection needs attention")).toBeVisible();
 expect(screen.getByText("5")).toBeVisible();
 expect(screen.getByText("2")).toBeVisible();
 expect(screen.getByText("PackProof could not read this folder.")).toBeVisible();
 expect(screen.queryByText("Recovered successfully")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:/Shipping/}));
 expect(onSource).toHaveBeenCalledWith("ship");
 fireEvent.click(screen.getByRole("button",{name:"Refresh actual status"}));
 await waitFor(()=>expect(bridge.getWorkspaceStatus).toHaveBeenCalledOnce());
});
it("redacts old facility source identity on access loss",()=>{
 const st=status(false);
 render(<RecoveryPanel status={st} sources={[ship]} busy={false} run={vi.fn()} bridge={bridgeFor(st)} onSource={vi.fn()}/>);
 expect(screen.getByText("Source details are hidden while current access cannot be confirmed.")).toBeVisible();
 expect(screen.queryByText("Shipping")).toBeNull();
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
