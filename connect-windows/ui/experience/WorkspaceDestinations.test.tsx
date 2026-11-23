// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ConnectStatus } from "../types";
import type { WorkspaceStatus, OrderDetail } from "../workspace-types";
import { selected, bridgeFor } from "../test-fixtures";
import { MatchingWorkspace, IntegrityWorkspace, ExportsWorkspace, WorkstationSettings } from "./WorkspaceDestinations";
import { Shell } from "./Shell";
import { Workspace } from "./Workspace";

const fixture = (data: Partial<WorkspaceStatus> = {}): ConnectStatus => ({
  ...selected,
  workspace: {
    phase: "active", step: "overview", viewKey: "facility-1", canReadOrders: true, sources: [],
    ...data,
  },
});
const callbacks = (status: ConnectStatus, overrides = {}) => {
  const bridge = bridgeFor(status, overrides);
  return {
    status, bridge, busy: false, run: vi.fn(async (fn: () => Promise<unknown>) => { await fn(); }),
    onSection: vi.fn(), onProof: vi.fn(), onOutputSetup: vi.fn(),
  };
};
afterEach(() => {cleanup(); localStorage.clear();});

it("shows only actual unresolved source observations and opens the authenticated matching review", async () => {
  const status = fixture();
  const c = callbacks(status);
  const report = {items:[
    {sourceId:"s1",fileName:"unmatched.csv",reason:"Order identifier unavailable",locator:"line 7"},
    {sourceId:"s2",fileName:"linked.json",proofId:"p2",revision:3}
  ],hasMore:false};
  render(<MatchingWorkspace {...c} report={report} error="" onRefresh={vi.fn()}/>);
  expect(screen.getByText("unmatched.csv")).toBeVisible();
  expect(screen.getByText("linked.json")).toBeVisible();
  expect(screen.getByText(/1 unmatched and 1 linked/)).toBeVisible();
  expect(screen.queryByText("ASSOCIATION VERIFIED")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:/unmatched.csv/}));
  await waitFor(() => expect(c.bridge.openWorkspaceReview).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button",{name:/linked.json/}));
  expect(c.onProof).toHaveBeenCalledWith("p2",3);
});

it("does not show matching observations when the current facility permission was revoked", () => {
  const status = fixture({canReadOrders:false});
  const c = callbacks(status);
  render(<MatchingWorkspace {...c} report={{items:[{fileName:"private.csv",reason:"private"}],hasMore:false}} error="" onRefresh={vi.fn()}/>);
  expect(screen.getByText("Current facility records aren't available.")).toBeVisible();
  expect(screen.queryByText("private.csv")).toBeNull();
});

it("loads the exact authorized Proof revision on explicit selection and never fabricates hash verification", async () => {
  const order = {proofId:"pp1",revision:4,orderReference:"SO-0042"};
  const status = fixture({orders:[order]});
  const detail: OrderDetail = {...order,events:[{
    eventKey:"e1",kind:"packing",sourceId:"s1",fileName:"packing.csv",
    observedAt:"2026-11-22T13:00:00Z",receiptId:"receipt1",originalSha256:"a".repeat(64)
  }],evidence:[],lines:[],integrity:"unknown"};
  const c=callbacks(status,{workspaceOrderDetail:vi.fn(async ()=>detail)});
  render(<IntegrityWorkspace {...c}/>);
  expect(c.bridge.workspaceOrderDetail).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:/SO-0042/}));
  await waitFor(()=>expect(c.bridge.workspaceOrderDetail).toHaveBeenCalledWith("pp1",4));
  expect(await screen.findByText("packing.csv")).toBeVisible();
  expect(screen.getByText(/Integrity reported by server: unknown/)).toBeVisible();
  expect(screen.queryByText(/0 content changes detected/i)).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Open evidence and history"}));
  expect(c.onProof).toHaveBeenCalledWith("pp1",4);
});

it("drops stale integrity information after facility switching even when IDs match", async () => {
  const order={proofId:"p1",revision:2,orderReference:"O-1"};
  const prior=fixture({orders:[order]});
  const second=fixture({viewKey:"another-facility",orders:[order]});
  const pending = vi.fn(async ():Promise<OrderDetail> => new Promise(()=>{}));
  const c=callbacks(prior,{workspaceOrderDetail:pending});
  const app=render(<IntegrityWorkspace {...c}/>);
  fireEvent.click(screen.getByRole("button",{name:/O-1/}));
  await waitFor(()=>expect(pending).toHaveBeenCalledOnce());
  app.rerender(<IntegrityWorkspace {...c} status={second}/>);
  expect(screen.getByText("Inspect an order's evidence")).toBeVisible();
});

it("exports remain pending until service confirms output, and calls the actual existing folder operations", async () => {
  const status: ConnectStatus = {
    ...fixture(),
    proofOutput:{folder:"C:\\Proofs",state:"pending",pending:2},
  };
  const c=callbacks(status);
  render(<ExportsWorkspace {...c}/>);
  expect(screen.getByText("C:\\Proofs")).toBeVisible();
  expect(screen.getByText(/Outstanding local copies/)).toBeVisible();
  expect(screen.queryByText("READY TO EXPORT")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Change Proof folder"}));
  expect(c.onOutputSetup).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button",{name:"Open local archive"}));
  await waitFor(()=>expect(c.bridge.openWorkspaceOutput).toHaveBeenCalledOnce());
});

it("settings change real local appearance and reduce motion and route diagnostics through the bridge", async () => {
  const status=fixture();
  const c=callbacks(status);
  render(<Shell status={status} section="settings" onSection={c.onSection}>
    <WorkstationSettings {...c}/>
  </Shell>);
  fireEvent.click(screen.getByRole("button",{name:/Light theme/}));
  const shell=document.querySelector(".pp-evidence-os");
  expect(shell).toHaveAttribute("data-appearance","light");
  fireEvent.click(screen.getByRole("button",{name:/Reduced motion/}));
  expect(shell).toHaveAttribute("data-motion","reduced");
  expect(localStorage.getItem("packproof.connect.motion.v1")).toBe("reduced");
  fireEvent.click(screen.getByRole("button",{name:"Export diagnostics"}));
  await waitFor(()=>expect(c.bridge.exportDiagnostics).toHaveBeenCalledOnce());
});

it("redacts cached orders and review panels immediately when service or facility permission becomes unverified", async () => {
  const privateOrder = {proofId:"private-proof", revision:3, orderReference:"PRIVATE-ORDER"};
  const granted = fixture({orders:[privateOrder]});
  const callbacks = {
    bridge: bridgeFor(granted), onStatus: vi.fn(), onSection: vi.fn(), onProof: vi.fn(),
  };
  const home = render(<Workspace {...callbacks} status={granted} section="home"/>);
  expect(screen.getAllByText("PRIVATE-ORDER").length).toBeGreaterThan(0);
  home.rerender(<Workspace {...callbacks}
    status={{...granted,transport:{...granted.transport!,state:"unsupported"}}} section="home"/>);
  expect(screen.queryByText("PRIVATE-ORDER")).toBeNull();
  expect(screen.getByText("Reconnect to your approved workspace to see its orders.")).toBeVisible();
  home.rerender(<Workspace {...callbacks} status={granted} section="orders"/>);
  expect(screen.getByText("PRIVATE-ORDER")).toBeVisible();
  home.rerender(<Workspace {...callbacks}
    status={{...granted,workspace:{...granted.workspace!,canReadOrders:undefined}}} section="orders"/>);
  expect(screen.queryByText("PRIVATE-ORDER")).toBeNull();
  expect(screen.getByText("Reconnect to your approved workspace to see its orders.")).toBeVisible();
});

it("does not show restricted match observations or claim online export access on unsupported transport", () => {
  const blocked = {...fixture(),transport:{...selected.transport!,state:"unsupported" as const}};
  const c = callbacks(blocked);
  const report = {items:[{sourceId:"s1",fileName:"private.csv",reason:"Unresolved"}],hasMore:false};
  const view = render(<MatchingWorkspace {...c} report={report} error="" onRefresh={vi.fn()}/>);
  expect(screen.queryByText("private.csv")).toBeNull();
  expect(screen.getByText("Current facility records aren't available.")).toBeVisible();
  view.rerender(<ExportsWorkspace {...c}/>);
  expect(screen.getByText("ACCESS REQUIRED")).toBeVisible();
  expect(screen.queryByText("AUTHENTICATED ACCESS")).toBeNull();
  expect(screen.getByText("— PENDING")).toBeVisible();
});

it("invalidates the selected integrity manifest on authorization loss and does not resurrect it after recovery", async () => {
  const order = {proofId:"revocable",revision:2,orderReference:"ORDER-PRIVATE"};
  const granted=fixture({orders:[order]});
  const detail:OrderDetail={...order,lines:[],events:[{eventKey:"e1",kind:"packing",
    sourceId:"s1",fileName:"secret-packing.csv",originalSha256:"a".repeat(64)}],evidence:[]};
  const c=callbacks(granted,{workspaceOrderDetail:vi.fn(async()=>detail)});
  const app=render(<IntegrityWorkspace {...c}/>);
  fireEvent.click(screen.getByRole("button",{name:/ORDER-PRIVATE/}));
  expect(await screen.findByText("secret-packing.csv")).toBeVisible();
  const blocked={...granted,transport:{...granted.transport!,state:"unsupported" as const}};
  app.rerender(<IntegrityWorkspace {...c} status={blocked}/>);
  expect(screen.queryByText("secret-packing.csv")).toBeNull();
  app.rerender(<IntegrityWorkspace {...c} status={granted}/>);
  expect(screen.getByText("Inspect an order's evidence")).toBeVisible();
  expect(screen.queryByText("secret-packing.csv")).toBeNull();
});
