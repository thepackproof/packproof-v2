import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PackProofApi } from "../api/client";
import { WorkspaceProofRecord } from "../components/WorkspaceProofRecord";
import { canonicalProof } from "./fixtures";

const videoEvidence = { ...canonicalProof.evidence[0], contentType: "video/mp4" };
const proof = { ...canonicalProof, evidence: [videoEvidence] };
const finalized = { ...proof, status: "FINALIZED", finalizedAt: "2026-09-06T11:00:00Z" };
const userId = "user_seller";
const anchor = { anchorId: "moment", evidenceId: videoEvidence.evidenceId, stageId: null, sourceHash: videoEvidence.sha256, sourceCategory: "USER_MARKED_OBSERVATION", label: "Identifier visible", startMs: 4000, endMs: 5000, supersedesId: null };
function apiStub(anchors: unknown[] = [], stages: unknown[] = []) {
  return {
    recoveryScope: "https://api.example.test",
    featureRequest: vi.fn(async () => ({ snapshot: { data: { anchors } } })),
    lifecycleRequest: vi.fn(async () => ({ role: "BUYER", stages })),
  };
}

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState({}, "", `/proofs/${proof.proofId}`);
  let index = 0;
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: vi.fn(() => `blob:record-${++index}`) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("simplified live Proof record", () => {
  it("opens the committed original under StrictMode and binds bookmarks to its hash and range", async () => {
    const api = apiStub([
      { ...anchor, anchorId: "old", label: "Old wording" },
      { ...anchor, supersedesId: "old" },
      { ...anchor, anchorId: "mismatch", label: "Wrong bytes", sourceHash: "bad-digest" },
      { ...anchor, anchorId: "range", label: "Invalid range", endMs: 2000 },
      { ...anchor, anchorId: "stage", label: "Receiving view", stageId: "receipt-stage" },
    ]);
    const load = vi.fn(async (_id: string) => new Blob(["original"], { type: "video/mp4" }));
    const { unmount } = render(<StrictMode><WorkspaceProofRecord proof={{ ...proof, evidence: [...proof.evidence, { ...videoEvidence, evidenceId: "pending", validationStatus: "PENDING" }] }} currentUserId={userId} role="SELLER" api={api as unknown as PackProofApi} loadEvidence={load} /></StrictMode>);
    const player = await screen.findByLabelText("Recorded packing evidence") as HTMLVideoElement;
    expect(load.mock.calls.every(call => call[0] === videoEvidence.evidenceId)).toBe(true);
    expect(await screen.findByRole("button", { name: "0:04 · Identifier visible" })).toBeInTheDocument();
    for (const label of ["Old wording", "Wrong bytes", "Invalid range", "Receiving view"]) expect(screen.queryByRole("button", { name: new RegExp(label) })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "0:04 · Identifier visible" }));
    expect(player.currentTime).toBe(4);
    expect(screen.getByRole("link", { name: "Download original evidence" })).toHaveAttribute("download", `packproof-${videoEvidence.evidenceId}.mp4`);
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("keeps unavailable originals retryable and never presents a failed file as playable", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("Evidence digest does not match")).mockResolvedValueOnce(new Blob(["valid"], { type: "video/mp4" }));
    render(<WorkspaceProofRecord proof={proof} currentUserId={userId} loadEvidence={load} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Evidence digest does not match");
    expect(screen.queryByLabelText("Recorded packing evidence")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry evidence" }));
    expect(await screen.findByLabelText("Recorded packing evidence")).toBeInTheDocument();
  });

  it("restores the selected tab and playback position on return and supports arrow keys", async () => {
    const load = vi.fn(async () => new Blob(["original"], { type: "video/mp4" }));
    const props = { proof, currentUserId: userId, loadEvidence: load };
    const first = render(<WorkspaceProofRecord {...props} />);
    const player = await screen.findByLabelText("Recorded packing evidence") as HTMLVideoElement;
    fireEvent.timeUpdate(player, { target: { currentTime: 12 } });
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.queryByLabelText("Recorded packing evidence")).not.toBeInTheDocument();
    first.unmount();
    const second = render(<WorkspaceProofRecord {...props} />);
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
    screen.getByRole("tab", { name: "Activity" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    const restored = await screen.findByLabelText("Recorded packing evidence") as HTMLVideoElement;
    fireEvent.loadedMetadata(restored);
    expect(restored.currentTime).toBe(12);
    expect(screen.getByRole("tab", { name: "Recording" })).toHaveFocus();
    second.unmount();
    render(<WorkspaceProofRecord {...props} currentUserId="different-user" />);
    const other = await screen.findByLabelText("Recorded packing evidence") as HTMLVideoElement;
    fireEvent.loadedMetadata(other);
    expect(other.currentTime).toBe(0);
  });

  it("uses recorded chronology and carrier reports in their own tabs", async () => {
    const selectEvent = vi.fn();
    render(<WorkspaceProofRecord proof={proof} currentUserId={userId} onOpenEvent={selectEvent} />);
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
    const timeline = screen.getByRole("tabpanel", { name: "Activity" });
    expect(within(timeline).getByText("Proof created")).toBeInTheDocument();
    const firstEvent = within(timeline).getAllByRole("listitem")[0];
    await userEvent.click(within(firstEvent).getByRole("button"));
    expect(selectEvent).toHaveBeenCalledWith(proof.chronology![0]);
    await userEvent.click(screen.getByRole("tab", { name: "Tracking" }));
    const tracking = screen.getByRole("tabpanel", { name: "Tracking" });
    expect(within(tracking).getByText("UPS")).toBeInTheDocument();
    expect(within(tracking).getByText("1Z999")).toBeInTheDocument();
    expect(within(tracking).getByText("Waiting for the first carrier update.")).toBeInTheDocument();
    expect(screen.queryByText(/Fictional|Illustrative stock|DEMO-1042/)).not.toBeInTheDocument();
  });

  it("keeps receipt workflows out of the record tabs and shows committed stage recordings", async () => {
    const api = { ...apiStub(), featureDownload: vi.fn(async () => new Blob(["receipt"], { type: "video/mp4" })) };
    const stage = { stageId: "stage_receipt", type: "RECEIPT", finalizedAt: null, evidence: [
      { evidenceId: "receipt", contentType: "video/mp4", byteSize: 7, sha256: "a", committedAt: "2026-09-06T12:00:00Z" },
      { evidenceId: "pending", contentType: "video/mp4", byteSize: 7, sha256: null, committedAt: null },
    ] };
    render(<WorkspaceProofRecord proof={{ ...finalized, commerceStages: [stage] }} currentUserId="user_buyer" role="BUYER" api={api as unknown as PackProofApi} loadEvidence={async () => new Blob(["packing"], { type: "video/mp4" })} />);
    expect(screen.queryByRole("tab", { name: "Receipt" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab").map(item => item.textContent)).toEqual(["Recording", "Activity", "Tracking"]);
    await screen.findByLabelText("Recorded packing evidence");
    await userEvent.click(screen.getByRole("button", { name: "Video 2" }));
    await waitFor(() => expect(api.featureDownload).toHaveBeenCalledWith(proof.proofId, "lifecycle/stages/stage_receipt/evidence/receipt"));
    expect(screen.queryByRole("button", { name: "Video 3" })).not.toBeInTheDocument();
  });
});
