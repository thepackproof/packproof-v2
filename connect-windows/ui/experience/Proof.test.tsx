// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Proof } from "./Proof";
import { modelProof, itemsInScope, quantity } from "./ProofModel";
import { originalFocusRange } from "./ProofOriginal";
import type { OrderDetail } from "../workspace-types";

afterEach(cleanup);
const ship = (id: string) => ({ type: "shipment", id, namespace: "wms" });
const event = (id: string, ref: string, qty: string, unit: string) => ({
  eventKey: id,
  receiptId: id + "-receipt",
  entity: ship(ref),
  kind: "packing",
  version: "1",
  fileName: ref + ".csv",
  sourceId: "wms",
  lines: [{ lineId: "10", sku: "Valve", unit, packedQuantity: qty }],
  locator: "line 2",
  observedAt: "2026-11-01T09:02:00Z",
});
const events = [event("evt1", "SH-A", "8", "EA"), event("evt2", "SH-B", "2", "BOX")];
const detail: OrderDetail = {
  proofId: "PP-real",
  orderReference: "SO-72",
  revision: 3,
  lines: [{ lineId: "10", sku: "Valve", packedQuantity: null, unit: null }],
  events,
  evidence: events.map((e) => ({
    ...e,
    eventKind: e.kind,
    kind: "derived_excerpt",
    originalStatus: "retained",
    fields: { note: "From warehouse" },
  })),
  conflicts: ["10: packedQuantity units"],
};
it("keeps split shipment units separate and opens the exact source and its provenance", async () => {
  const read = vi.fn(async () => ({ kind: "original" as const, originalText: "qty,unit\n8,EA" }));
  render(<Proof detail={detail} onBack={vi.fn()} readOriginal={read} />);
  fireEvent.click(screen.getByRole("tab", { name: "Items" }));
  fireEvent.change(screen.getByLabelText("Fulfillment scope"), {
    target: { value: JSON.stringify(["wms", "shipment", "SH-A"]) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Valve: Packed 8 EA" }));
  const dialog = screen.getByRole("dialog");
  expect(await within(dialog).findByText("8,EA")).toBeVisible();
  expect(read).toHaveBeenCalledWith("PP-real", 3, "evt1");
  fireEvent.click(within(dialog).getByRole("button", { name: "Source details" }));
  expect(within(dialog).getByText("evt1-receipt")).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.getByRole("tab", { name: "Items" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("button", { name: "Valve: Packed 8 EA" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Valve: Packed 2 BOX" })).toBeNull();
});
it("scopes live search and preserves proof-wide history", () => {
  render(<Proof detail={detail} onBack={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Fulfillment scope"), {
    target: { value: JSON.stringify(["wms", "shipment", "SH-A"]) },
  });
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "SH-B" } });
  expect(screen.getByText("No matching items, records, or review notes in this scope.")).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  expect(screen.getAllByText("Source record received")).toHaveLength(2);
});
it("does not attach merged event quantities to legacy receipts without allocations", () => {
  const prior = {
    ...events[0],
    lines: undefined,
    eventKind: "packing",
    fields: { note: "Corrected source" },
  };
  const m = modelProof({
    ...detail,
    lines: [{ lineId: "10", packedQuantity: "8", unit: "EA" }],
    events: [events[0]],
    evidence: [prior],
  });
  expect(quantity(m, m.items[0], "packedQuantity", "").sources).toEqual([]);
});
it("keeps draft preview separate from published revisions and original reads", () => {
  const read = vi.fn();
  render(
    <Proof
      mode="draft"
      detail={{ ...detail, events: [], evidence: [], lines: [], conflicts: [] }}
      onBack={vi.fn()}
      readOriginal={read}
    />,
  );
  expect(screen.getByRole("heading", { name: "Order preview" })).toBeVisible();
  expect(screen.queryByText(/Revision 3/)).toBeNull();
  expect(read).not.toHaveBeenCalled();
});
it("compares confirmed stage values within a delivery; includes labeled whole-order context", () => {
  const a = {
    ...events[0],
    eventKey: "load",
    lines: [{ lineId: "10", sku: "Valve", unit: "EA", loadedQuantity: "8.0" }],
  };
  const b = {
    ...a,
    eventKey: "receive",
    lines: [{ lineId: "10", sku: "Valve", unit: "EA", acknowledgedQuantity: "6.000" }],
  };
  const whole = {
    ...a,
    eventKey: "erp",
    kind: "order",
    entity: { type: "order", namespace: "erp", id: "SO-72" },
    references: [ship("SH-A"), ship("SH-B")],
    lines: [{ lineId: "10", unit: "EA", orderedQuantity: "24" }],
  };
  const m = modelProof({
    ...detail,
    lines: [{ lineId: "10", unit: "EA", orderedQuantity: "24" }],
    events: [a, b, whole],
    evidence: [],
  });
  const scope = JSON.stringify(["wms", "shipment", "SH-A"]),
    item = itemsInScope(m, scope)[0];
  expect(item.difference).toContain("2 EA difference");
  expect(quantity(m, item, "orderedQuantity", scope)).toMatchObject({ text: "24", orderContext: true });
  expect(itemsInScope(m, JSON.stringify(["wms", "shipment", "SH-B"]))).toEqual([]);
});
it("retains only the specific receipt supporting a changed, preserved, or cleared quantity", () => {
  const a = {
    ...events[0],
    eventId: "ev",
    version: "1",
    lines: [{ lineId: "10", packedQuantity: "3", unit: "EA" }],
  };
  const b = {
    ...a,
    eventKey: "correct",
    version: "2",
    lines: [{ lineId: "10", packedQuantity: "8", unit: "EA" }],
  };
  const c = {
    ...a,
    eventKey: "latest",
    version: "3",
    lines: [{ lineId: "10", pickedQuantity: "2", unit: "EA" }],
  };
  const proof = {
    ...detail,
    lines: [{ lineId: "10", packedQuantity: "8", unit: "EA" }],
    events: [c],
    evidence: [a, b, c],
  };
  const m = modelProof(proof);
  expect(quantity(m, m.items[0], "packedQuantity", "").sources.map((s) => s.row.eventKey)).toEqual([
    "correct",
  ]);
  const cleared = modelProof({
    ...proof,
    evidence: [
      ...proof.evidence,
      { ...c, eventKey: "clear", version: "4", lines: [{ lineId: "10", packedQuantity: null }] },
    ],
  });
  expect(quantity(cleared, cleared.items[0], "packedQuantity", "").sources).toEqual([]);
});
it("highlights the exact JSON allocation or quoted CSV record without reformatting the original", () => {
  const json = '{"lines":[{"lineId":"L10","loadedQuantity":"8"},{"lineId":"L20","loadedQuantity":"24"}]}';
  expect(json.slice(...originalFocusRange(json, "application/json", "L10", "loadedQuantity", "")!)).toBe(
    '{"lineId":"L10","loadedQuantity":"8"}',
  );
  const csv = 'lineId,notes,loadedQuantity\r\nL10,"some\nnotes",8\r\nL20,fitting,24';
  expect(csv.slice(...originalFocusRange(csv, "text/csv", "L10", "loadedQuantity", "")!)).toBe(
    'L10,"some\nnotes",8',
  );
  expect(originalFocusRange(csv + "\r\nL10,other,8", "text/csv", "L10", "loadedQuantity", "")).toBeNull();
});
it("takes Riverside from split shipment to the original focused line and keeps the future delivery separate", async () => {
  const { riversideSample, sampleOriginal } = await import("./preview");
  render(<Proof mode="sample" detail={riversideSample} readOriginal={sampleOriginal} onBack={vi.fn()} />);
  const picker = screen.getByLabelText("Fulfillment scope");
  const options = within(picker).getAllByRole("option") as HTMLOptionElement[];
  expect(options).toHaveLength(3);
  const shipment = (id: string) => options.find((o) => o.textContent?.includes(id))!.value;
  fireEvent.change(picker, { target: { value: shipment("SH-01") } });
  expect(
    screen.getByRole("heading", { name: /2 EA difference between loaded and acknowledged/ }),
  ).toBeVisible();
  expect(screen.getByText("Branch operations")).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "Items" }));
  fireEvent.click(screen.getByRole("button", { name: "2-inch ball valve: Loaded 8 EA" }));
  const d = screen.getByRole("dialog");
  await within(d).findByRole("heading", { name: "Original content" });
  expect(d.querySelector("mark")).toHaveTextContent("L10");
  expect(d.querySelector("mark")).toHaveTextContent(/loadedQuantity/);
  fireEvent.click(within(d).getByRole("button", { name: "Close" }));
  fireEvent.change(picker, { target: { value: shipment("SH-02") } });
  expect(screen.getByRole("button", { name: "Circulation pump: Ordered 2 EA" })).toBeVisible();
  expect(screen.getAllByText("Not due")).toHaveLength(3);
  fireEvent.click(screen.getByRole("tab", { name: "Evidence" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Filter evidence by source" }), {
    target: { value: "WMS" },
  });
  expect(screen.getByText("No source records match this view.")).toBeVisible();
});

it.each([{ conflicts: [] as string[] }, { conflicts: ["30: sku"] }])(
  "summarizes a multi-line order without attributing the first item's quantity to the whole proof (conflicts %j)",
  ({ conflicts }) => {
    const order: OrderDetail = {
      ...detail,
      lines: [
        { lineId: "20", sku: "Valve", orderedQuantity: "2", unit: "each" },
        { lineId: "30", sku: "Pump", orderedQuantity: "1", unit: "each" },
      ],
      conflicts,
    };
    render(<Proof detail={order} onBack={vi.fn()} />);
    const counts = screen.getByLabelText("Whole proof overview counts");
    expect(within(counts).getByRole("button", { name: /Line items 2 View items/ })).toBeVisible();
    expect(within(counts).getByRole("button", { name: /Reported events 2 View journey/ })).toBeVisible();
    expect(within(counts).getByRole("button", { name: /Source records 2 View evidence/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Ordered 2 each/ })).toBeNull();
    fireEvent.click(within(counts).getByRole("button", { name: /Line items/ }));
    expect(screen.getByRole("button", { name: "Valve: Ordered 2 each" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Pump: Ordered 1 each" })).toBeVisible();
  }
);
