import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PackProofApi } from "../api/client";
import { clearStationCapture, recoverStationCapture, saveStationCapture, stationCaptureKey } from "../capture-queue";
import { PackingStationScreen } from "../screens/PackingStationScreen";
import { stationContextFromProof } from "../../../mobile/src/packing-station/display";
import { canonicalProof } from "./fixtures";

afterEach(async () => {
  cleanup();
  await clearStationCapture("user_seller");
  vi.unstubAllGlobals();
});

it("restores station bytes and finishes the exact committed recording after a reload", async () => {
  const file = new NodeBlob(["preserved packing video"], { type: "video/webm" }) as unknown as Blob;
  const ready = { ...canonicalProof, status: "READY_FOR_EVIDENCE", evidence: [], attestations: [], participationPolicy: "COUNTERPARTY_OPTIONAL" as const };
  await saveStationCapture({
    key: stationCaptureKey("user_seller"), file,
    order: stationContextFromProof(ready), uploadKey: "original-upload", evidenceId: "saved-recording", finishConfirmed: true,
  });
  expect(await recoverStationCapture("different-account")).toBeNull();
  expect(await (await recoverStationCapture("user_seller"))!.file.text()).toBe("preserved packing video");
  let proof = {
    ...ready, status: "EVIDENCE_COMMITTED",
    evidence: [{ ...canonicalProof.evidence[0], evidenceId: "saved-recording", evidenceType: "FULFILLMENT_CAPTURE", validationStatus: "COMMITTED" as const }],
  };
  const api = {
    getProof: vi.fn(async () => proof),
    initializeEvidenceUpload: vi.fn(), uploadObject: vi.fn(), commitEvidence: vi.fn(),
    createAttestation: vi.fn(async () => ({ proof })),
    finalizeProof: vi.fn(async () => { proof = { ...proof, status: "FINALIZED" }; return { proof }; }),
  };
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:recovered-station");
    static revokeObjectURL = vi.fn();
  });
  render(<PackingStationScreen api={api as unknown as PackProofApi} userId="user_seller" queue={[]} error={null} onAuthExpired={() => {}} />);
  const retry = await screen.findByRole("button", { name: "Retry upload" });
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  expect(await screen.findByText("PROOF CREATED")).toBeInTheDocument();
  expect(api.initializeEvidenceUpload).not.toHaveBeenCalled();
  expect(api.uploadObject).not.toHaveBeenCalled();
  expect(api.commitEvidence).not.toHaveBeenCalled();
  expect(api.createAttestation).toHaveBeenCalledWith(ready.proofId, { statement: "PACKED_DESCRIBED_ITEM", relatedEvidenceId: "saved-recording" });
  expect(api.finalizeProof).toHaveBeenCalledTimes(1);
  expect(await recoverStationCapture("user_seller")).toBeNull();
});
