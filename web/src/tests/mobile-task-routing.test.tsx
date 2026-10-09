import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App";
import { saveSession } from "../auth/session";
import { summary, canonicalProof } from "./fixtures";

const queue = vi.hoisted(() => ({ list: vi.fn(async () => []), resume: vi.fn(async () => undefined) }));
vi.mock("../capture-queue", async original => ({ ...await original<typeof import("../capture-queue")>(), listRecoverableRecordings: queue.list, resumeLocalRecordings: queue.resume }));
vi.mock("../analytics/study-capture", async original => ({ ...await original<typeof import("../analytics/study-capture")>(), flushStudyTimings: vi.fn(async () => undefined) }));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  sessionStorage.clear(); localStorage.clear();
  window.history.replaceState({}, "", "/app");
  Object.defineProperties(HTMLDialogElement.prototype, { close: { configurable: true, value() { this.removeAttribute("open"); } }, showModal: { configurable: true, value() { this.setAttribute("open", ""); } } });
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: query === "(max-width: 760px)", media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true }));
  saveSession({ apiBaseUrl: "", authMode: "dev", userId: "user_seller", username: "seller", displayName: "Seller", token: "test-token", refreshToken: null, accessExpiresAt: null, subject: "seller" });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function mockApi(completedOnTap = false) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === "/me/proofs") return json({ proofs: completedOnTap ? [summary] : [] });
    if (path === "/me/fulfillment-queue") return json({ items: [] });
    if (path === "/me/integration-connections") return json({ connections: [] });
    if (path === "/me/marketplaces") return json({ marketplaces: [] });
    if (path === "/invitations") return json({ invitations: [] });
    if (path === "/me/capabilities") return json({ userId: "user_seller", roles: [], isAdmin: false });
    if (path === "/me/onboarding") return json({ onboarding_completed: true, onboarding_version: 1, first_proof_coaching_completed: true, onboarding_enrolled: false, current_version: 1 });
    if (path === `/proofs/${summary.proofId}`) return json({ ...canonicalProof, status: "FINALIZED", finalizedAt: "2026-10-09T12:00:00Z" });
    if (path === `/proofs/${summary.proofId}/shipment-integrity`) return json({ status: "NO_SHIPMENT", events: [] });
    return json({ error: { code: "UNAVAILABLE", message: "Optional feature unavailable in test" } }, 404);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
it("navigates Home to Pack and starts manual creation in one tap without integrations", async () => {
  const fetch = mockApi();
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Create your first Proof" })).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole("navigation", { name: "Primary navigation" })).getByRole("link", { name: "Pack" }));
  expect(await screen.findByRole("heading", { name: "Pack" })).toBeInTheDocument();
  expect(window.location.pathname).toBe("/pack");
  fireEvent.click(within(screen.getByRole("navigation", { name: "Primary navigation" })).getByRole("link", { name: "Home" }));
  fireEvent.click(await screen.findByRole("button", { name: "Create Proof" }));
  expect(await screen.findByLabelText("What are you shipping?")).toBeInTheDocument();
  expect(window.location.pathname).toBe("/new");
  expect(fetch.mock.calls.every(([input]) => !String(input).includes("connected-accounts/connect"))).toBe(true);
});
it("revalidates a recommended target and opens the finalized record instead of camera", async () => {
  const fetch = mockApi(true);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Continue Proof" }));
  await waitFor(() => expect(window.location.pathname).toBe(`/proofs/${summary.proofId}`));
  expect(screen.getByText("This Proof is already finalized. Its current record is ready to view.")).toBeInTheDocument();
  expect(fetch.mock.calls.some(([input]) => String(input).endsWith(`/proofs/${summary.proofId}`))).toBe(true);
  expect(window.location.pathname.endsWith("/capture")).toBe(false);
});
it("rollback disables the mobile composition without touching upload recovery", async () => {
  vi.stubEnv("VITE_PACKPROOF_MOBILE_TASK_UX", "false");
  mockApi();
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Home" })).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "Primary navigation" })).not.toBeInTheDocument();
  await waitFor(() => expect(queue.list).toHaveBeenCalled());
  vi.unstubAllEnvs();
});
