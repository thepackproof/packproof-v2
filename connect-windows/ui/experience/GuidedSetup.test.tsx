// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import type { FacilityDraft, FacilityInputs } from "../guided-workflow-types";
import { bridgeFor, selected } from "../test-fixtures";
import type { ConnectStatus } from "../types";
import type { WorkspaceSource } from "../workspace-types";
import { Setup } from "./Setup";
import { assistantFields } from "./SetupAssistant";

afterEach(cleanup);
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
