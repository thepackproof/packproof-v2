// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { selected } from "../test-fixtures";
import type { ConnectStatus } from "../types";
import { Shell } from "./Shell";

const active: ConnectStatus = {
  ...selected,
  workspace: {
    phase: "active",
    step: "overview",
    viewKey: "scope-1",
    canReadOrders: true,
    sources: [
      { id: "sales", folder: "C:\\Warehouse\\Orders", generation: 1, roles: ["order"],
        state: "active", recognition: { state: "recognized", message: "Found order records." } },
    ],
  },
};
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

it("keeps all navigation actions on the existing functional Logistics sections", () => {
  const onSection = vi.fn();
  render(
    <Shell status={active} section="home" onSection={onSection}>
      <main>Authorized content</main>
    </Shell>,
  );
  expect(screen.getByText("Authorized content")).toBeVisible();
  expect(screen.getByText("Evidence collection active")).toBeVisible();
  expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  fireEvent.click(screen.getByRole("button", { name: "Orders & proofs" }));
  fireEvent.click(screen.getByRole("button", { name: "Exceptions" }));
  fireEvent.click(screen.getByRole("button", { name: "Connected systems" }));
  expect(onSection.mock.calls.map(([value]) => value)).toEqual(["orders", "attention", "connections"]);
});

it("switches appearance without altering workspace identity, permissions or real connection state", () => {
  const onSection = vi.fn();
  const view = render(<Shell status={active} section="home" onSection={onSection}>Live data</Shell>);
  const shell = view.container.querySelector(".pp-evidence-os");
  expect(shell).toHaveAttribute("data-appearance", "dark");
  fireEvent.click(screen.getByRole("button", { name: "Switch to light appearance" }));
  expect(shell).toHaveAttribute("data-appearance", "light");
  expect(window.localStorage.getItem("packproof.connect.appearance.v1")).toBe("light");
  expect(screen.getByText("1 approved source collecting")).toBeVisible();
  expect(onSection).not.toHaveBeenCalled();
});

it("never displays a false collecting state when the background service is offline", () => {
  const offline: ConnectStatus = {
    ...active,
    health: { ...active.health, serviceOnline: false },
  };
  render(<Shell status={offline} section="home" onSection={vi.fn()}>Offline</Shell>);
  expect(screen.getByText("Background service offline")).toBeVisible();
  expect(screen.queryByText("Evidence collection active")).not.toBeInTheDocument();
});
