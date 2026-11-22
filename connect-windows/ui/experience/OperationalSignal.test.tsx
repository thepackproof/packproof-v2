// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { selected } from "../test-fixtures";
import type { ConnectStatus } from "../types";
import type { WorkspaceStatus } from "../workspace-types";
import { operationsOverview } from "./operations-overview";
import { OperationalSignal } from "./OperationalSignal";

const NOW = Date.parse("2026-11-22T14:00:00.000Z");
const status = (workspace: Partial<WorkspaceStatus> = {}): ConnectStatus => ({
  ...selected,
  workspace: {
    phase: "active",
    step: "overview",
    canReadOrders: true,
    viewKey: "authorized-facility",
    sources: [],
    ...workspace,
  },
});

afterEach(cleanup);

it("never presents Figma's illustrative facility totals as actual metrics", () => {
  const m = operationsOverview(status({ orders: [] }), NOW);
  expect(m.metrics.observedOrders).toBe("—");
  expect(m.metrics.updatedOrders).toBe("—");
  expect(m.metrics.connectedSources).toBe("0/0");
  expect(m.bucketBasis).toBe("unavailable");
  expect(m.activity).toHaveLength(0);
});

it("counts only the latest visible revision of each order and labels the chart as a recent-page sample", () => {
  const a = { proofId: "one", orderReference: "SO-100", revision: 1, updatedAt: "2026-11-22T12:01:00Z" };
  const s = status({
    totalOrders: 100,
    updatedLast24Hours: 37,
    orders: [
      a,
      { ...a, revision: 2, updatedAt: "2026-11-22T13:12:00Z" },
      { proofId: "two", orderReference: "SO-101", revision: 1, updatedAt: "2026-11-22T13:14:00Z" },
      { proofId: "three", orderReference: "SO-102", revision: 1, updatedAt: "not-a-date" },
    ],
    sources: [
      { id: "a", folder: "C:\\ERP", roles: ["order"], state: "active", generation: 1,
        recognition: { state: "recognized", message: "Recognized ERP" } },
      { id: "b", folder: "C:\\Carrier", roles: ["shipping"], state: "needs_attention", generation: 1,
        recognition: { state: "unavailable", message: "Carrier offline" } },
    ],
  });
  const m = operationsOverview(s, NOW);
  expect(m.metrics.observedOrders).toBe("100");
  expect(m.metrics.updatedOrders).toBe("37");
  expect(m.metrics.connectedSources).toBe("1/2");
  expect(m.datedOrders).toBe(2);
  expect(m.buckets.reduce((count, b) => count + b.count, 0)).toBe(2);
  expect(m.bucketBasis).toBe("recent-page");
  expect(m.activity).toHaveLength(3);
  expect(m.activity.find((order) => order.proofId === "one")?.revision).toBe(2);
});

it("never discloses cached records after service failure or facility permission loss", () => {
  const cached = status({
    orders: [{ proofId: "private", revision: 5, orderReference: "SECRET-ORDER", updatedAt: "2026-11-22T13:10:00Z" }],
  });
  for (const offline of [
    { ...cached, health: { ...cached.health, serviceOnline: false } },
    { ...cached, workspace: { ...cached.workspace!, canReadOrders: false } },
    { ...cached, transport: { ...cached.transport!, state: "forbidden" as const } },
  ]) {
    const m = operationsOverview(offline, NOW);
    expect(m.canRead).toBe(false);
    expect(m.metrics.observedOrders).toBe("—");
    expect(m.activity).toEqual([]);
    expect(m.bucketBasis).toBe("unavailable");
  }
});

it("opens real existing workspace actions and Proof revisions, not mock screens", () => {
  const onOrders = vi.fn();
  const onAttention = vi.fn();
  const onConnections = vi.fn();
  const onProof = vi.fn();
  render(
    <OperationalSignal
      status={status({
        orders: [{ proofId: "proof-1", revision: 4, orderReference: "SO-10482", latestKind: "packing",
          updatedAt: "2026-11-22T13:12:00Z" }],
      })}
      needsAttention="3"
      onOrders={onOrders}
      onAttention={onAttention}
      onConnections={onConnections}
      onProof={onProof}
    />,
  );
  expect(screen.getByRole("heading", { name: "Operations, at a glance." })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Orders observed/ }));
  fireEvent.click(screen.getByRole("button", { name: /Needs attention/ }));
  fireEvent.click(screen.getByRole("button", { name: /Connected sources/ }));
  fireEvent.click(screen.getByRole("button", { name: /SO-10482/ }));
  expect(onOrders).toHaveBeenCalledOnce();
  expect(onAttention).toHaveBeenCalledOnce();
  expect(onConnections).toHaveBeenCalledOnce();
  expect(onProof).toHaveBeenCalledWith("proof-1", 4);
});
