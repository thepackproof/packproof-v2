import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App";
import { PackProofApi } from "../api/client";
import { saveSession } from "../auth/session";
import { LocalRecordingRecovery } from "../components/LocalRecordingRecovery";
import type { LocalRecordingSummary } from "../capture-queue";
import { demoConnection, fulfillmentItem } from "./fixtures";

const recovery = vi.hoisted(() => ({ list: vi.fn(), resume: vi.fn(), remove: vi.fn() }));
vi.mock("../capture-queue", async importOriginal => ({
  ...await importOriginal<typeof import("../capture-queue")>(),
  listRecoverableRecordings: recovery.list,
  resumeLocalRecordings: recovery.resume,
  removePreservedLocalRecording: recovery.remove,
}));
vi.mock("../analytics/study-capture", async importOriginal => ({
  ...await importOriginal<typeof import("../analytics/study-capture")>(),
  flushStudyTimings: vi.fn(async () => undefined),
}));

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState({}, "", "/fulfillment");
  recovery.list.mockResolvedValue([]);
  recovery.resume.mockResolvedValue(undefined);
  recovery.remove.mockResolvedValue(undefined);
  saveSession({ apiBaseUrl: "", authMode: "dev", userId: "user_seller", username: "seller", displayName: "Seller", token: "test-token", refreshToken: null, accessExpiresAt: null, subject: "seller" });
});

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

function mockWorkspace(orderResponse: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === "/me/fulfillment-queue") return orderResponse();
    if (url.pathname === "/me/integration-connections") return json({ connections: [demoConnection] });
    if (url.pathname === "/me/capabilities") return json({ userId: "user_seller", roles: [], isAdmin: false });
    if (url.pathname === "/me/onboarding") return json({ onboarding_completed: true, onboarding_version: 1, first_proof_coaching_completed: true, onboarding_last_step: null, onboarding_enrolled: false, current_version: 1, first_proof_id: null, first_proof_completed: false });
    return json({ error: { code: "NOT_FOUND", message: "Optional feature unavailable" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

it("loads all fulfillment states so the Orders Completed tab can show the server's finalized orders", async () => {
  const complete = { ...fulfillmentItem, proofId: "proof_complete", externalReference: "COMPLETE-ORDER", proofStatus: "FINALIZED", workflowState: "COMPLETED" };
  const fetchMock = mockWorkspace(() => json({ items: [fulfillmentItem, complete], filter: "all" }));
  render(<App />);
  expect(await screen.findByRole("button", { name: "DS-1001" })).toBeInTheDocument();
  const requests = fetchMock.mock.calls.map(([input]) => new URL(String(input), window.location.origin)).filter(url => url.pathname === "/me/fulfillment-queue");
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(url => url.searchParams.get("filter") === "all")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Completed" }));
  expect(screen.getByRole("button", { name: "COMPLETE-ORDER" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "DS-1001" })).not.toBeInTheDocument();
});

it("replaces a failed Orders load with its successful retry instead of retaining the old error screen", async () => {
  let attempts = 0;
  mockWorkspace(() => ++attempts === 1 ? json({ error: { code: "UPSTREAM_UNAVAILABLE", message: "Orders temporarily unavailable" } }, 503) : json({ items: [fulfillmentItem], filter: "all" }));
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Orders could not be loaded");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("button", { name: "DS-1001" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Refresh workspace" })).toBeEnabled();
  expect(attempts).toBe(2);
});

it("publishes the recovery worker's latest snapshot and the remaining list after removing a completed local copy", async () => {
  const api = new PackProofApi({ baseUrl: "", getToken: async () => "test-token" });
  const saved: LocalRecordingSummary = { key: "saved_original", kind: "ordinary", file: new Blob(["saved recording"]), proofId: "proof_saved", preserved: false, finalized: false, accepted: true, committed: true, available: true };
  const completed = { ...saved, preserved: true, finalized: true };
  recovery.list.mockResolvedValueOnce([saved]).mockResolvedValueOnce([completed]).mockResolvedValue([]);
  const onRecordingsChange = vi.fn();
  render(<LocalRecordingRecovery api={api} userId="user_seller" onOpen={vi.fn()} onRecordingsChange={onRecordingsChange} />);
  await waitFor(() => expect(onRecordingsChange).toHaveBeenLastCalledWith([completed]));
  fireEvent.click(screen.getByText(/Saved originals on this device/));
  fireEvent.click(screen.getByRole("button", { name: "Remove completed local copy" }));
  await waitFor(() => expect(recovery.remove).toHaveBeenCalledWith("user_seller", saved.key, api));
  await waitFor(() => expect(onRecordingsChange).toHaveBeenLastCalledWith([]));
  expect(screen.queryByRole("complementary", { name: "Saved recordings" })).not.toBeInTheDocument();
});
