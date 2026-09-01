import { describe, expect, it, vi } from "vitest";
import { submitStationSession, type StationSubmitApi } from "../../mobile/src/packing-station/submit.ts";
import type { StationCaptureRef, StationProofSnapshot } from "../../mobile/src/packing-station/types.ts";

const capture: StationCaptureRef = {
  handle: "file://pack.mp4",
  contentType: "video/mp4",
  byteSize: 12,
  durationMs: 4000,
};

function snapshot(overrides: Partial<StationProofSnapshot> = {}): StationProofSnapshot {
  return {
    proofId: "proof_1",
    transactionId: "txn_1",
    status: "READY_FOR_EVIDENCE",
    participationPolicy: "COUNTERPARTY_OPTIONAL",
    participants: [{ userId: "seller", role: "SELLER" }],
    evidence: [],
    attestations: [],
    transaction: { externalReference: "4821", itemTitle: "Charizard" },
    ...overrides,
  };
}

function apiMock(sequence: StationProofSnapshot[]): StationSubmitApi & { calls: string[] } {
  const calls: string[] = [];
  let proof = sequence[0] ?? snapshot();
  return {
    calls,
    async initializeEvidenceUpload(proofId, input) {
      calls.push(`init:${proofId}:${input.evidenceType ?? ""}:${input.idempotencyKey}`);
      return {
        evidenceId: "evd_1",
        upload: { method: "PUT", url: "http://example.test/upload/t", headers: {} },
      };
    },
    async commitEvidence(proofId) {
      calls.push(`commit:${proofId}`);
      proof = sequence[1] ?? {
        ...proof,
        status: "EVIDENCE_COMMITTED",
        evidence: [{ validationStatus: "COMMITTED" }],
      };
      return { proof };
    },
    async createAttestation(proofId, input) {
      calls.push(`attest:${proofId}:${input.relatedEvidenceId ?? ""}`);
      proof = sequence[2] ?? {
        ...proof,
        attestations: [{ statement: "PACKED_DESCRIBED_ITEM", attestedBy: "seller" }],
      };
      return { proof };
    },
    async finalizeProof(proofId) {
      calls.push(`finalize:${proofId}`);
      proof = sequence[3] ?? { ...proof, status: "FINALIZED" };
      return { proof };
    },
    async getProof(proofId) {
      calls.push(`get:${proofId}`);
      return sequence[4] ?? proof;
    },
  };
}

describe("packing station submit", () => {
  it("uploads, commits, attests, and finalizes the resolved merchant Proof", async () => {
    const api = apiMock([
      snapshot(),
      snapshot({
        status: "EVIDENCE_COMMITTED",
        evidence: [{ validationStatus: "COMMITTED" }],
      }),
      snapshot({
        status: "EVIDENCE_COMMITTED",
        evidence: [{ validationStatus: "COMMITTED" }],
        attestations: [{ statement: "PACKED_DESCRIBED_ITEM", attestedBy: "seller" }],
      }),
      snapshot({
        status: "FINALIZED",
        evidence: [{ validationStatus: "COMMITTED" }],
        attestations: [{ statement: "PACKED_DESCRIBED_ITEM", attestedBy: "seller" }],
      }),
      snapshot({
        status: "FINALIZED",
        evidence: [{ validationStatus: "COMMITTED" }],
        attestations: [{ statement: "PACKED_DESCRIBED_ITEM", attestedBy: "seller" }],
      }),
    ]);
    const upload = vi.fn(async () => undefined);
    const result = await submitStationSession({
      proof: snapshot(),
      actorUserId: "seller",
      capture,
      idempotencyKey: "idem_same",
      deps: { api, upload, newIdempotencyKey: () => "generated" },
    });
    expect(result.completion).toBe("FINALIZED");
    expect(result.proof.proofId).toBe("proof_1");
    expect(result.idempotencyKey).toBe("idem_same");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(api.calls.filter((item) => item.startsWith("init:"))).toEqual([
      "init:proof_1:FULFILLMENT_CAPTURE:idem_same",
    ]);
    expect(api.calls.some((item) => item.startsWith("attest:proof_1:evd_1"))).toBe(true);
    expect(api.calls).toContain("finalize:proof_1");
  });

  it("retries with the same idempotency key after a failed upload", async () => {
    const api = apiMock([
      snapshot(),
      snapshot({
        status: "EVIDENCE_COMMITTED",
        evidence: [{ validationStatus: "COMMITTED" }],
      }),
    ]);
    const upload = vi
      .fn()
      .mockRejectedValueOnce({ code: "UPLOAD_FAILED", message: "down" })
      .mockResolvedValueOnce(undefined);
    await expect(
      submitStationSession({
        proof: snapshot(),
        actorUserId: "seller",
        capture,
        idempotencyKey: "idem_retry",
        deps: { api, upload, newIdempotencyKey: () => "unused" },
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
    expect(api.calls.some((item) => item.startsWith("commit:"))).toBe(false);

    api.calls.length = 0;
    await submitStationSession({
      proof: snapshot(),
      actorUserId: "seller",
      capture,
      idempotencyKey: "idem_retry",
      deps: { api, upload, newIdempotencyKey: () => "unused" },
    });
    expect(api.calls.filter((item) => item.startsWith("init:"))).toEqual([
      "init:proof_1:FULFILLMENT_CAPTURE:idem_retry",
    ]);
  });

  it("refuses to mutate a finalized Proof and does not upload", async () => {
    const api = apiMock([snapshot({ status: "FINALIZED" })]);
    const upload = vi.fn();
    await expect(
      submitStationSession({
        proof: snapshot({ status: "FINALIZED" }),
        actorUserId: "seller",
        capture,
        deps: { api, upload, newIdempotencyKey: () => "x" },
      }),
    ).rejects.toMatchObject({ code: "PROOF_ALREADY_FINALIZED" });
    expect(upload).not.toHaveBeenCalled();
    expect(api.calls).toEqual([]);
  });

  it("maps authentication failure to a recoverable station error", async () => {
    const api = apiMock([snapshot()]);
    api.initializeEvidenceUpload = async () => {
      throw { code: "UNAUTHENTICATED", status: 401, message: "Missing bearer token" };
    };
    await expect(
      submitStationSession({
        proof: snapshot(),
        actorUserId: "seller",
        capture,
        deps: { api, upload: async () => undefined, newIdempotencyKey: () => "x" },
      }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
