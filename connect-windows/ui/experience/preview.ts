import type { DraftPreview, OrderDetail, WorkspaceSourceRecord } from "../workspace-types";
type Entry = Record<string, unknown>;
type Ref = { id: string; type: string; namespace: string };
interface ExampleRecord {
  id: string;
  source: string;
  kind: string;
  file: string;
  occurred: string;
  received: string;
  fields: Entry;
  lines: Entry[];
  references?: Ref[];
  version?: string;
}
const shipment = (id: string): Ref => ({ type: "shipment", namespace: "demo-dispatch", id });
function createSample(
  proofId: string,
  revision: number,
  orderReference: string,
  lines: Entry[],
  inputs: ExampleRecord[],
): OrderDetail {
  const events = inputs.map((r) => ({
    eventKey: r.id,
    receiptId: "example-" + r.id,
    sourceId: r.source,
    sourceName: r.source,
    kind: r.kind,
    eventKind: r.kind,
    fileName: r.file,
    version: r.version || "1",
    occurredAt: r.occurred,
    observedAt: r.received,
    fields: r.fields,
    lines: r.lines,
    references: r.references || [],
    locator: "Example record",
  }));
  return {
    proofId,
    revision,
    orderReference,
    lines,
    events,
    evidence: events.map((e) => ({ ...e, kind: "derived_excerpt", originalStatus: "example" })),
    updatedAt: events.at(-1)?.observedAt,
  };
}
const valve = {
  lineId: "L10",
  sku: "BV-200",
  title: "2-inch ball valve",
  unit: "EA",
  shipmentReference: "SH-01",
};
const fitting = {
  lineId: "L20",
  sku: "ELB-090",
  title: "90° elbow fitting",
  unit: "EA",
  shipmentReference: "SH-01",
};
const pump = {
  lineId: "L30",
  sku: "PUMP-75",
  title: "Circulation pump",
  unit: "EA",
  shipmentReference: "SH-02",
};
const pair = (key: string, a: string, b: string) => [
  { ...valve, [key]: a },
  { ...fitting, [key]: b },
];
const t = (time: string) => "2026-10-27T" + time + ":00-04:00";
const quantities = [
  {
    ...valve,
    orderedQuantity: "8",
    pickedQuantity: "8",
    loadedQuantity: "8",
    acknowledgedQuantity: "6",
    loadedAcknowledgedDiscrepancy: "2 EA more loaded than acknowledged",
  },
  {
    ...fitting,
    orderedQuantity: "24",
    pickedQuantity: "24",
    loadedQuantity: "24",
    acknowledgedQuantity: "24",
  },
  {
    ...pump,
    orderedQuantity: "2",
    backorderedQuantity: "2",
    pickedQuantityState: "not_due",
    loadedQuantityState: "not_due",
    acknowledgedQuantityState: "not_due",
  },
];
export const riversideSample = createSample("PP-04821", 12, "SO-104882", quantities, [
  {
    id: "order",
    source: "ERP",
    kind: "order",
    file: "order-SO-104882-r2.json",
    version: "2",
    references: [shipment("SH-01"), shipment("SH-02")],
    occurred: t("07:30"),
    received: t("07:31"),
    fields: {
      customerName: "Riverside Mechanical",
      purchaseOrder: "RIV-286",
      fulfillmentStatus: "Partial fulfillment",
      plannedShipmentReference: "SH-02",
      plannedDeliveryDate: "2026-10-29",
    },
    lines: [
      ...pair("orderedQuantity", "8", "24"),
      { ...pump, orderedQuantity: "2", backorderedQuantity: "2" },
    ],
  },
  {
    id: "pick",
    source: "WMS",
    kind: "picking",
    file: "pick-PK-731.csv",
    occurred: t("08:10"),
    received: t("08:11"),
    references: [shipment("SH-01")],
    fields: { pickTicket: "PK-731" },
    lines: pair("pickedQuantity", "8", "24"),
  },
  {
    id: "load",
    source: "WMS",
    kind: "load",
    file: "load-HU-17.json",
    occurred: t("08:42"),
    received: t("08:43"),
    references: [shipment("SH-01")],
    fields: { handlingUnit: "HU-17" },
    lines: pair("loadedQuantity", "8", "24"),
  },
  {
    id: "handoff",
    source: "Dispatch",
    kind: "handoff",
    file: "receipt-SH-01.json",
    occurred: t("10:06"),
    received: t("10:07"),
    references: [shipment("SH-01")],
    fields: { handoff: "Signed", itemCounts: "Not recorded" },
    lines: [],
  },
  {
    id: "receive",
    source: "Receiving",
    kind: "receiving",
    file: "receiving-RC-92.json",
    occurred: t("10:08"),
    received: t("10:10"),
    references: [shipment("SH-01")],
    fields: {
      receivingReport: "RC-92",
      followUpStatus: "open",
      followUpRequest: "Receiver clarification",
      followUpOwner: "Branch operations",
      followUpRequestedAt: t("10:13"),
      followUpEvidenceState: "missing",
    },
    lines: pair("acknowledgedQuantity", "6", "24"),
  },
]);
const northItems = ["½-inch brass ball valve", "Pressure gauge", "Pipe fitting kit"].map((title, i) => ({
  title,
  lineId: String(i + 1),
  unit: "EA",
}));
export const northSample = createSample(
  "PP-10482",
  1,
  "10482",
  northItems.map((l) => ({ ...l, orderedQuantity: "1", packedQuantity: "1" })),
  [
    {
      id: "north-order",
      source: "Order software",
      kind: "order",
      file: "order-10482.json",
      occurred: t("11:02"),
      received: t("11:03"),
      fields: { customerName: "North Ridge Supply" },
      lines: northItems.map((l) => ({ ...l, orderedQuantity: "1" })),
    },
    {
      id: "north-pack",
      source: "Packing",
      kind: "packing",
      file: "packing-10482.json",
      occurred: t("12:31"),
      received: t("12:32"),
      fields: { orderReference: "10482" },
      lines: northItems.map((l) => ({ ...l, packedQuantity: "1" })),
    },
    {
      id: "north-ship",
      source: "Shipping",
      kind: "label",
      file: "shipping-10482.json",
      occurred: t("14:04"),
      received: t("14:05"),
      fields: { orderReference: "10482", deliveryConfirmation: "Awaiting carrier confirmation" },
      lines: [],
    },
  ],
);
export async function sampleOriginal(
  id: string,
  revision: number,
  key: string,
): Promise<WorkspaceSourceRecord> {
  const sample = [northSample, riversideSample].find((p) => p.proofId === id && p.revision === revision);
  const record = sample?.events.find((e) => e.eventKey === key);
  if (!record) throw new Error("That example source is unavailable.");
  const file = String(record.fileName),
    lines = record.lines as Entry[],
    csv = file.endsWith(".csv"),
    keys = Object.keys(lines[0] || {});
  const originalText = csv
    ? [
        keys.join(","),
        ...lines.map((r) => keys.map((k) => '"' + String(r[k] ?? "").replaceAll('"', '""') + '"').join(",")),
      ].join("\n")
    : JSON.stringify({ orderReference: sample?.orderReference, ...(record.fields as Entry), lines }, null, 2);
  return {
    kind: "original",
    eventKey: key,
    receiptId: "example-" + key,
    sourceId: String(record.sourceId),
    fileName: file,
    originalText,
    mediaType: csv ? "text/csv" : "application/json",
  };
}
export function draftProof(d: DraftPreview["examples"][number]): OrderDetail {
  const events = d.events.map((e) => ({
    ...e,
    sourceName: e.source,
    fileName: e.fileName,
    occurredAt: e.occurredAt,
    associationScope: e.shared ? "shared" : "order",
  }));
  return {
    proofId: d.orderReference,
    revision: 0,
    orderReference: d.displayReference || d.orderReference,
    lines: d.lines.map((l) => ({ lineId: l.lineId, sku: l.sku, unit: l.unit, orderedQuantity: l.quantity })),
    packages: d.cartons?.map(carton => ({ packageId: carton.id, ...carton })) ?? d.packages.map((id) => ({ packageId: id })),
    events,
    evidence: [],
  };
}
