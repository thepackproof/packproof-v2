// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { WorkspaceApp } from "./WorkspaceApp";
import { bridgeFor, selected } from "./test-fixtures";
import type { ConnectStatus } from "./types";
import type { DraftPreview, OrderDetail, WorkspaceSource, WorkspaceStatus } from "./workspace-types";

afterEach(cleanup);

function status(workspace: Partial<WorkspaceStatus> = {}): ConnectStatus {
  return { ...selected, workspace: { step: "order", phase: "draft", sources: [], ...workspace } };
}
function active(workspace: Partial<WorkspaceStatus> = {}): ConnectStatus {
  return status({ phase: "active", step: "overview", canReadOrders: true, viewKey: "approved-view", ...workspace });
}
async function clickButton(name: string | RegExp) {
  fireEvent.click(await screen.findByRole("button", { name }));
}
const folder: WorkspaceSource = {
  id: "source1", roles: ["order"], folder: "C:\\Warehouse\\Sales reports", generation: 1, state: "pending",
  recognition: { state: "recognized", message: "Found order records.",
    sample: { orderReference: "SO10482", eventId: "technical-event-000", sku: "A100" } },
};
const preview: DraftPreview = {
  scannedFiles: 3, unresolved: 1, limited: true, unreadFiles: 0,
  examples: [{ orderReference: "SO10482", source: "Sales", packages: ["PKG93"],
    lines: [{ lineId: "30", quantity: "1", unit: "EA", sku: "A100" }],
    events: [{ kind: "label", source: "Shipping", fileName: "labels.json", occurredAt: "", shared: false }] }],
};

it("saves the source step, displays inspected business fields and reuses the chosen folder", async () => {
  let current = status();
  const bridge = bridgeFor(current, {
    getStatus: async () => current,
    chooseWorkspaceFolder: vi.fn(async () => current = status({ sources: [folder] })),
    workspaceDraftPreview: vi.fn(async () => preview),
    saveWorkspaceStep: vi.fn(async step => current = status({ ...current.workspace, step })),
    reuseWorkspaceFolder: vi.fn(async () => current = status({ ...current.workspace, sources: [{ ...folder, roles: ["order", "picking"] }] })),
  });
  render(<WorkspaceApp bridge={bridge}/>);
  await clickButton("Connect my records");
  await clickButton(/In a spreadsheet or folder/);
  await clickButton(/Choose a folder myself/);
  expect(await screen.findByText("SO10482")).toBeVisible();
  expect(screen.getByText("3 files checked · Showing a sample")).toBeVisible();
  expect(screen.queryByText("technical-event-000")).toBeNull();
  expect(bridge.chooseWorkspaceFolder).toHaveBeenCalledWith("order");
  await clickButton("Add another source");
  const choices = screen.getByRole("dialog", { name: "Which records would you like to add?" });
  fireEvent.click(within(choices).getByRole("button", { name: "Picking records" }));
  await clickButton(/Use Sales reports/);
  await waitFor(() => expect(bridge.reuseWorkspaceFolder).toHaveBeenCalledWith("source1", "picking"));
  expect(bridge.saveWorkspaceStep).toHaveBeenCalledWith("picking");
  expect(bridge.activateWorkspace).not.toHaveBeenCalled();
});

it("resumes the persisted review and inspects a matched record from the bounded local preview", async () => {
  const current = status({ step: "review", sources: [folder] });
  const bridge = bridgeFor(current, { workspaceDraftPreview: vi.fn(async () => preview) });
  render(<WorkspaceApp bridge={bridge}/>);
  expect(await screen.findByRole("heading", { name: "SO10482" })).toBeVisible();
  expect(screen.getByText("1 record needs an order reference.")).toBeVisible();
  await clickButton(/Label created.*labels.json/);
  const record = screen.getByRole("dialog", { name: "Label created" });
  expect(within(record).getByText("labels.json")).toBeVisible();
  expect(within(record).getByText("Shipping")).toBeVisible();
  expect(within(record).getByText("Local source preview")).toBeVisible();
  expect(bridge.workspaceOrderDetail).not.toHaveBeenCalled();
  expect(bridge.activateWorkspace).not.toHaveBeenCalled();
});

it("blocks denied destinations and requests explicit consent when local copies are temporarily unavailable", async () => {
  const current = status({ step: "activate", outputFolder: "C:\\Proofs", outputState: "denied", sources: [folder] });
  const denied = bridgeFor(current);
  const app = render(<WorkspaceApp bridge={denied}/>);
  expect(await screen.findByRole("button", { name: "Review in browser" })).toBeDisabled();
  expect(denied.activateWorkspace).not.toHaveBeenCalled();
  app.unmount();

  const bridge = bridgeFor(status({ ...current.workspace, outputState: "unavailable" }));
  render(<WorkspaceApp bridge={bridge}/>);
  const pending = await screen.findByRole("button", { name: "Start with local copies pending" });
  expect(bridge.activateWorkspace).not.toHaveBeenCalled();
  fireEvent.click(pending);
  await waitFor(() => expect(bridge.activateWorkspace).toHaveBeenCalledWith(true));
});

it("resumes browser approval and opens the committed proof revision from the workspace", async () => {
  let current = status({ step: "activate", phase: "awaiting_approval", approvalPath: "/app/records/connect/approve?installationId=i" });
  const order = { proofId: "p1", orderReference: "SO10482", revision: 3 };
  const discrepancy = "1 EA more ordered than shipped";
  const bridge = bridgeFor(current, {
    getStatus: async () => current,
    workspaceOrderDetail: vi.fn(async () => ({ ...order, lines: [{ lineId: "20", sku: "A100", unit: "EA",
      orderedQuantity: "3", shippedQuantity: "2", orderedShippedDiscrepancy: discrepancy }], events: [], evidence: [] })),
  });
  render(<WorkspaceApp bridge={bridge}/>);
  const review = await screen.findByRole("button", { name: "Open browser review" });
  await act(async () => { fireEvent.click(review); });
  expect(bridge.openWorkspaceApproval).toHaveBeenCalledOnce();
  current = active({ orders: [order] });
  fireEvent.focus(window);
  await clickButton("Open my workspace");
  expect(await screen.findByRole("heading", { name: "Workspace overview" })).toBeVisible();
  await clickButton(/SO10482/);
  expect(await screen.findByRole("heading", { name: "Proof p1" })).toBeVisible();
  expect(screen.getByRole("heading", { name: discrepancy })).toBeVisible();
  expect(bridge.workspaceOrderDetail).toHaveBeenCalledWith("p1", 3);
});

it("checks approval immediately after activation returns pending", async () => {
  const draft = status({ step: "activate", outputFolder: "C:\\Proofs", outputState: "ready", sources: [folder] });
  const awaiting = status({ ...draft.workspace, phase: "awaiting_approval", approvalPath: "/app/records/connect/approve?installationId=i" });
  const approved = active({ sources: [folder] });
  const bridge = bridgeFor(draft, {
    activateWorkspace: vi.fn(async () => awaiting),
    getWorkspaceStatus: vi.fn(async () => approved),
  });
  render(<WorkspaceApp bridge={bridge}/>);
  await clickButton("Review in browser");
  expect(await screen.findByRole("heading", { name: "Automatic updates are on." })).toBeVisible();
  expect(bridge.activateWorkspace).toHaveBeenCalledTimes(1);
  expect(bridge.getWorkspaceStatus).toHaveBeenCalled();
});

it("asks which source owns an ambiguous reference before confirming a profile", async () => {
  const current = status({ sources: [{ ...folder, recognition: { state: "ambiguous", message: "Read picking references.",
    relatedChoices: [{ role: "order", options: [{ id: "sales1", displayName: "Sales East" }, { id: "sales2", displayName: "Sales West" }] }] } }] });
  const bridge = bridgeFor(current);
  render(<WorkspaceApp bridge={bridge}/>);
  await clickButton("Sales West");
  await waitFor(() => expect(bridge.chooseWorkspaceRelatedSource).toHaveBeenCalledWith("source1", 1, "order", "sales2"));
  expect(bridge.confirmWorkspaceOrderMap).not.toHaveBeenCalled();
});

it("adds a direct order system to the draft without requesting folder access", async () => {
  const bridge = bridgeFor(status());
  render(<WorkspaceApp bridge={bridge}/>);
  await clickButton("Connect my records");
  await clickButton(/In our order software/);
  fireEvent.click(screen.getByText("Use an existing PackProof Partner API integration"));
  await clickButton("Connect PackProof Partner API");
  await waitFor(() => expect(bridge.addWorkspaceDirectSource).toHaveBeenCalledWith(undefined));
  expect(bridge.chooseWorkspaceFolder).not.toHaveBeenCalled();
  expect(bridge.activateWorkspace).not.toHaveBeenCalled();
});

it("finds an order outside the recent list and opens the authorized revision online", async () => {
  const order = { proofId: "older", revision: 4, orderReference: "000120" };
  const bridge = bridgeFor(active({ orders: [] }), {
    workspaceSearchOrders: vi.fn(async () => [order]),
    workspaceOrderDetail: vi.fn(async () => ({ ...order, lines: [], evidence: [], events: [] })),
  });
  render(<WorkspaceApp bridge={bridge}/>);
  await clickButton("Orders");
  fireEvent.change(screen.getByRole("searchbox", { name: "Order reference" }), { target: { value: "000120" } });
  await clickButton("Find order");
  await clickButton(/000120/);
  expect(await screen.findByRole("heading", { name: "Proof older" })).toBeVisible();
  await clickButton("Record details");
  const details = screen.getByRole("dialog", { name: "Record details" });
  fireEvent.click(within(details).getByRole("button", { name: /Open online order/ }));
  expect(bridge.workspaceSearchOrders).toHaveBeenCalledWith("000120");
  expect(bridge.workspaceOrderDetail).toHaveBeenCalledWith("older", 4);
  expect(bridge.openWorkspaceOrder).toHaveBeenCalledWith("older", 4);
});

it("discards a proof read that completes after switching the approved workspace", async () => {
  const oldOrder = { proofId: "old-proof", revision: 2, orderReference: "West-120" };
  const newOrder = { proofId: "new-proof", revision: 1, orderReference: "East-806" };
  let current = active({ orders: [oldOrder] });
  let finishRead!: (detail: OrderDetail) => void;
  const inFlight = new Promise<OrderDetail>(resolve => { finishRead = resolve; });
  const bridge = bridgeFor(current, {
    getStatus: async () => current,
    workspaceOrderDetail: vi.fn(() => inFlight),
  });
  render(<WorkspaceApp bridge={bridge}/>);
  await clickButton(/West-120/);
  await waitFor(() => expect(bridge.workspaceOrderDetail).toHaveBeenCalledWith("old-proof", 2));
  current = active({ viewKey: "new-grant", orders: [newOrder] });
  fireEvent.focus(window);
  expect(await screen.findByRole("button", { name: /East-806/ })).toBeVisible();
  await act(async () => { finishRead({ ...oldOrder, lines: [], evidence: [], events: [] }); });
  expect(screen.queryByRole("heading", { name: "Proof old-proof" })).toBeNull();
  expect(screen.getByRole("button", { name: /East-806/ })).toBeVisible();
});
