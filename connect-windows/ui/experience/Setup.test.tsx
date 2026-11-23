// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { bridgeFor, selected } from "../test-fixtures";
import type { ConnectStatus } from "../types";
import type { DraftPreview, WorkspaceBridge, WorkspaceFolderSuggestion, WorkspaceSource, WorkspaceStatus } from "../workspace-types";
import { Setup } from "./Setup";

afterEach(cleanup);

it('prioritizes the authorized facility connection for an installation without a facility',async()=>{
  const state:ConnectStatus={...selected,installationId:'installation_test',setupAccess:{reason:'facility_required'},workspace:{phase:'draft',step:'order',sources:[]}};
  const bridge=bridgeFor(state);
  render(<Harness initial={state} bridge={bridge}/>);
  expect(screen.getByRole('heading',{name:'Choose this computer’s facility.'})).toBeVisible();
  expect(screen.queryByRole('button',{name:'Discover my systems'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Try a sample order'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Choose a facility'}));
  await waitFor(()=>expect(bridge.openWorkspaceApproval).toHaveBeenCalledTimes(1));
  expect(bridge.recoverEnrollment).not.toHaveBeenCalled();
  expect(bridge.chooseWorkspaceFolder).not.toHaveBeenCalled();
});

it('requires explicit preservation consent before existing recovery and returns to facility enrollment',async()=>{
  const state:ConnectStatus={...selected,state:'revoked',installationId:'installation_test',binding:undefined,recoveryAvailable:true,setupAccess:{reason:'reapproval_required'},workspace:{phase:'draft',step:'order',sources:[]}};
  const fresh:ConnectStatus={state:'needs_approval',environment:'development',setupAccess:{reason:'enrollment_required'},health:{serviceOnline:true,queueCount:0},workspace:{phase:'draft',step:'order',sources:[]}};
  const bridge=bridgeFor(state,{recoverEnrollment:vi.fn(async()=>fresh),beginEnrollment:vi.fn(async()=>fresh)});
  render(<Harness initial={state} bridge={bridge}/>);
  const recover=screen.getByRole('button',{name:'Preserve work and reconnect'});
  expect(recover).toBeDisabled();expect(bridge.recoverEnrollment).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox',{name:'Preserve former pending work and begin new browser approval.'}));
  fireEvent.click(recover);
  await waitFor(()=>expect(bridge.recoverEnrollment).toHaveBeenCalledWith({preservePendingWorkApproved:true}));
  expect(await screen.findByRole('heading',{name:'Connect this computer to a facility.'})).toBeVisible();
  expect(bridge.beginEnrollment).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Connect this computer'}));
  await waitFor(()=>expect(bridge.beginEnrollment).toHaveBeenCalledTimes(1));
});

it('reopens the exact pending approval with its comparison code without creating another enrollment',async()=>{
  const state:ConnectStatus={state:'needs_approval',environment:'development',setupAccess:{reason:'enrollment_required'},health:{serviceOnline:true,queueCount:0},workspace:{phase:'draft',step:'order',sources:[]},
    enrollment:{id:'enrollment_test',state:'pending',expiresAt:'2099-01-01T00:00:00Z',comparisonCode:'A1B2C3'}};
  const bridge=bridgeFor(state);
  render(<Harness initial={state} bridge={bridge}/>);
  expect(screen.getByText('A1B2C3')).toBeVisible();
  expect(screen.queryByRole('button',{name:'Discover my systems'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Reopen facility sign-in'}));
  await waitFor(()=>expect(bridge.openWorkspaceApproval).toHaveBeenCalledTimes(1));
  expect(bridge.beginEnrollment).not.toHaveBeenCalled();
});

it('keeps failed recovery actionable and does not advance to enrollment',async()=>{
  const state:ConnectStatus={...selected,installationId:'installation_test',recoveryAvailable:true,setupAccess:{reason:'reapproval_required'},workspace:{phase:'draft',step:'order',sources:[]}};
  const bridge=bridgeFor(state,{recoverEnrollment:vi.fn(async()=>{throw Error('The protected archive could not be saved.');})});
  render(<Harness initial={state} bridge={bridge}/>);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button',{name:'Preserve work and reconnect'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('The protected archive could not be saved.');
  expect(screen.getByRole('button',{name:'Preserve work and reconnect'})).toBeEnabled();
  expect(bridge.beginEnrollment).not.toHaveBeenCalled();
});

const folder: WorkspaceSource = {
  id: "orders",
  folder: "C:\\Sales",
  roles: ["order"],
  generation: 1,
  state: "pending",
  recognition: { state: "recognized", message: "Order records found." },
};
const init = (workspace: Partial<WorkspaceStatus> = {}): ConnectStatus => ({
  ...selected,
  workspace: { phase: "draft", step: "order", sources: [], ...workspace },
});
const example: DraftPreview["examples"][number] = {
  orderReference: "REAL-37",
  source: "Sales",
  lines: [{ lineId: "4", sku: "BV45", unit: "EA", quantity: "12" }],
  packages: [],
  events: [{ kind: "order", source: "Sales", fileName: "sales.csv", occurredAt: "", shared: false }],
};
const preview = () =>
  Promise.resolve({ limited: false, unresolved: 0, unreadFiles: 0, scannedFiles: 1, examples: [example] });

function Harness({
  initial,
  bridge,
  openDraft,
}: {
  initial: ConnectStatus;
  bridge: WorkspaceBridge;
  openDraft?: (e: typeof example) => void;
}) {
  const [status, setStatus] = useState(initial);
  return (
    <Setup
      status={status}
      onStatus={setStatus}
      bridge={bridge}
      onComplete={() => {}}
      onSample={() => {}}
      onOpenDraftProof={openDraft}
    />
  );
}

it("takes a real selected source through local proof, destination selection and browser approval", async () => {
  let state = init();
  const update = (changes: Partial<WorkspaceStatus>) =>
    (state = { ...state, workspace: { ...state.workspace!, ...changes } });
  const bridge = bridgeFor(state, {
    chooseWorkspaceFolder: vi.fn(async () => update({ sources: [folder] })),
    workspaceDraftPreview: vi.fn(preview),
    saveWorkspaceStep: vi.fn(async (step) => update({ step })),
    chooseWorkspaceOutput: vi.fn(async () => update({ outputFolder: "C:\\Proofs", outputState: "ready" })),
    activateWorkspace: vi.fn(async () =>
      update({ step: "activate", phase: "awaiting_approval", approvalPath: "/approval" }),
    ),
  });
  const openDraft = vi.fn();
  render(<Harness initial={state} bridge={bridge} openDraft={openDraft} />);
  fireEvent.click(screen.getByRole("button", { name: "Discover my systems" }));
  fireEvent.click(screen.getByRole("button", { name: /In a spreadsheet or folder/ }));
  fireEvent.click(screen.getByRole("button", { name: /Choose a folder myself/ }));
  const openOrder = await screen.findByRole("button", { name: "Open order REAL-37" });
  expect(screen.getByText(folder.folder)).toBeVisible();
  expect(screen.getByText(/Approval covers the original files in your chosen folder/)).toBeVisible();
  fireEvent.click(openOrder);
  expect(await screen.findByRole("heading", { name: "REAL-37" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Open the full proof/ }));
  expect(openDraft).toHaveBeenCalledWith(example);
  expect(screen.queryByText("North Ridge Supply")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Turn on automatic updates" }));
  expect(await screen.findByRole("button", { name: "Continue" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Choose proof folder" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  const approve = await screen.findByRole("button", { name: "Review in browser" });
  expect(screen.getByText(`Order records · ${folder.folder}`)).toBeVisible();
  expect(screen.getByText(/including existing files, new files, and files it can’t match/)).toBeVisible();
  fireEvent.click(approve);
  expect(await screen.findByRole("button", { name: "Open browser review" })).toBeVisible();
  expect(bridge.activateWorkspace).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Automatic updates are on.")).toBeNull();
});

it("requires permission for unavailable output and never starts collection for a denied destination", async () => {
  const denied = init({
    step: "activate",
    sources: [folder],
    outputFolder: "C:\\Proofs",
    outputState: "denied",
  });
  const { unmount } = render(<Harness initial={denied} bridge={bridgeFor(denied)} />);
  expect(screen.getByRole("button", { name: "Review in browser" })).toBeDisabled();
  unmount();
  const pending = init({ ...denied.workspace, outputState: "unavailable" });
  const bridge = bridgeFor(pending);
  render(<Harness initial={pending} bridge={bridge} />);
  fireEvent.click(screen.getByRole("button", { name: "Start with local copies pending" }));
  await waitFor(() => expect(bridge.activateWorkspace).toHaveBeenCalledWith(true));
});

it("keeps software exports distinct from direct partner integration", async () => {
  const initial = init();
  const bridge = bridgeFor(initial);
  render(<Harness initial={initial} bridge={bridge} />);
  fireEvent.click(screen.getByRole("button", { name: "Discover my systems" }));
  fireEvent.click(screen.getByRole("button", { name: /In our order software/ }));
  fireEvent.click(screen.getByRole("button", { name: /Microsoft Dynamics 365/ }));
  expect(screen.getByRole("heading", { name: "Connect your Microsoft Dynamics 365 orders." })).toBeVisible();
  expect(bridge.addWorkspaceDirectSource).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Choose my export folder/ }));
  await waitFor(() => expect(bridge.chooseWorkspaceFolder).toHaveBeenCalledWith("order"));
  expect(screen.queryByText("Automatic updates are on.")).toBeNull();
});

it("finds multiple order exports and previews only the folder the operator chooses", async () => {
  const initial = init();
  const shop = { kind: "discovered" as const, folder: "C:\\Sales", label: "Shopify orders", evidence: "Matched order and line item columns" };
  const warehouse = { kind: "discovered" as const, folder: "C:\\Warehouse", label: "Warehouse orders", evidence: "Matched order and quantity columns" };
  const bridge = bridgeFor(initial, {
    discoverWorkspaceFolders: vi.fn(async () => [shop, warehouse]),
    useWorkspaceFolderSuggestion: vi.fn(async () => init({ sources: [{ ...folder, folder: warehouse.folder }] })),
    workspaceDraftPreview: vi.fn(preview),
  });
  render(<Harness initial={initial} bridge={bridge} />);
  expect(bridge.discoverWorkspaceFolders).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Discover my systems" }));
  expect(await screen.findByRole("button", { name: /Shopify orders.*Matched order and line item columns.*Sales/ })).toBeVisible();
  expect(bridge.discoverWorkspaceFolders).toHaveBeenCalledWith("order");
  expect(bridge.useWorkspaceFolderSuggestion).not.toHaveBeenCalled();
  expect(bridge.workspaceDraftPreview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Warehouse orders.*Matched order and quantity columns/ }));
  expect(await screen.findByRole("button", { name: "Open order REAL-37" })).toBeVisible();
  expect(bridge.useWorkspaceFolderSuggestion).toHaveBeenCalledExactlyOnceWith("order", warehouse.folder);
  expect(bridge.chooseWorkspaceFolder).not.toHaveBeenCalled();
  expect(bridge.activateWorkspace).not.toHaveBeenCalled();
});

it("separates a prepared folder from matches and keeps manual setup available after a scan failure", async () => {
  const initial = init();
  const bridge = bridgeFor(initial, {
    discoverWorkspaceFolders: vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([{ folder: "C:\\Prepared", kind: "prepared" }]),
    useWorkspaceFolderSuggestion: vi.fn(),
  });
  render(<Harness initial={initial} bridge={bridge} />);
  fireEvent.click(screen.getByRole("button", { name: "Discover my systems" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("couldn’t finish checking");
  expect(screen.getByRole("button", { name: "Choose a folder myself" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("group", { name: "Other available folders" })).toHaveTextContent("Prepared");
  expect(screen.getByRole("status")).toHaveTextContent("didn’t recognize a matching export");
  expect(screen.queryByRole("group", { name: "Matching exports" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Choose a folder myself" }));
  await waitFor(() => expect(bridge.chooseWorkspaceFolder).toHaveBeenCalledWith("order"));
  expect(bridge.useWorkspaceFolderSuggestion).not.toHaveBeenCalled();
});

it("searches for the new record role as soon as the operator adds a source", async () => {
  const initial = init({ sources: [folder] });
  const bridge = bridgeFor(initial, {
    discoverWorkspaceFolders: vi.fn(async () => []),
    saveWorkspaceStep: vi.fn(async step => init({ sources: [folder], step })),
  });
  render(<Harness initial={initial} bridge={bridge} />);
  fireEvent.click(screen.getByRole("button", { name: "Add another source" }));
  fireEvent.click(screen.getByRole("button", { name: "Shipping records" }));
  expect(await screen.findByRole("heading", { name: "Find your shipping records." })).toBeVisible();
  await waitFor(() => expect(bridge.discoverWorkspaceFolders).toHaveBeenCalledExactlyOnceWith("shipping"));
  expect(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled();
});

it("keeps a delayed scan from interrupting software setup", async () => {
  let finish!: (folders: WorkspaceFolderSuggestion[]) => void;
  const discovery = new Promise<WorkspaceFolderSuggestion[]>(resolve => { finish = resolve; });
  const initial = init();
  const bridge = bridgeFor(initial, { discoverWorkspaceFolders: vi.fn(() => discovery) });
  render(<Harness initial={initial} bridge={bridge} />);
  fireEvent.click(screen.getByRole("button", { name: "Discover my systems" }));
  expect(screen.getByRole("status")).toHaveTextContent("Looking in common export folders");
  fireEvent.click(screen.getByRole("button", { name: "Choose my software" }));
  await act(async () => { finish([{ kind: "discovered", folder: "C:\\Late" }]); });
  expect(screen.getByRole("heading", { name: /Which software does your team use/ })).toBeVisible();
  expect(screen.queryByRole("group", { name: "Matching exports" })).toBeNull();
});

it("supports older desktops that provide a single suggestion", async () => {
  const initial = init();
  const bridge = bridgeFor(initial, {
    getWorkspaceFolderSuggestion: vi.fn(async () => ({ kind: "selected" as const, folder: folder.folder })),
    useWorkspaceFolderSuggestion: vi.fn(async () => init({ sources: [folder] })),
  });
  render(<Harness initial={initial} bridge={bridge} />);
  fireEvent.click(screen.getByRole("button", { name: "Discover my systems" }));
  fireEvent.click(screen.getByRole("button", { name: /Help me find my records/ }));
  const suggested = await screen.findByRole("button", { name: /Sales.*Previously selected/ });
  expect(bridge.useWorkspaceFolderSuggestion).not.toHaveBeenCalled();
  fireEvent.click(suggested);
  await waitFor(() => expect(bridge.useWorkspaceFolderSuggestion).toHaveBeenCalledWith("order", folder.folder));
});
