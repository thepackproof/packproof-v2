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

  it("recovers an idempotent retry without receiving fresh upload authority", async () => {
    const recovered = snapshot({
      status: "EVIDENCE_COMMITTED",
      participationPolicy: "COUNTERPARTY_REQUIRED",
      evidence: [{ evidenceId: "evd_committed", validationStatus: "COMMITTED" }],
    });
    const api = apiMock([snapshot()]);
    api.initializeEvidenceUpload = async () => {
      throw {
        code: "EVIDENCE_ALREADY_COMMITTED",
        message: "Committed evidence cannot receive another upload authorization",
      };
    };
    api.getProof = async (proofId) => {
      api.calls.push(`get:${proofId}`);
      return recovered;
    };
    const upload = vi.fn(async () => undefined);

    const result = await submitStationSession({
      proof: snapshot(),
      actorUserId: "seller",
      capture,
      idempotencyKey: "idem_committed",
      evidenceId: "evd_committed",
      deps: { api, upload, newIdempotencyKey: () => "unused" },
    });

    expect(result.evidenceId).toBe("evd_committed");
    expect(result.completion).toBe("EVIDENCE_COMMITTED");
    expect(upload).not.toHaveBeenCalled();
    expect(api.calls.some((item) => item.startsWith("commit:"))).toBe(false);
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

  it("still requires a capture commit after a verified finish identity", async () => {
    const api = apiMock([snapshot()]);
    const upload = vi.fn(async () => undefined);
    await submitStationSession({
      proof: snapshot(),
      actorUserId: "seller",
      capture,
      idempotencyKey: "idem_rescan",
      deps: { api, upload, newIdempotencyKey: () => "generated" },
    });
    expect(api.calls.filter((item) => item.startsWith("init:"))).toEqual([
      "init:proof_1:FULFILLMENT_CAPTURE:idem_rescan",
    ]);
    expect(upload).toHaveBeenCalledTimes(1);
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

  it("does not initialize or upload evidence when seller authorization is cancelled", async () => {
    const api = apiMock([snapshot()]);
    const upload = vi.fn();
    const prepareAttestation = vi.fn(async () => {
      throw { code: "BIOMETRIC_CANCELLED", message: "Fingerprint confirmation was cancelled." };
    });

    await expect(submitStationSession({
      proof: snapshot(), actorUserId: "seller", capture,
      deps: { api, upload, prepareAttestation, newIdempotencyKey: () => "cancelled" },
    })).rejects.toMatchObject({ code: "BIOMETRIC_CANCELLED" });

    expect(prepareAttestation).toHaveBeenCalledOnce();
    expect(upload).not.toHaveBeenCalled();
    expect(api.calls).toEqual([]);
  });

  it.each(["COUNTERPARTY_OPTIONAL", "COUNTERPARTY_REQUIRED"])(
    "authorizes before upload and signs this exact evidence under %s despite a prior attestation",
    async (participationPolicy) => {
      const initial = snapshot({ participationPolicy });
      const committed = snapshot({
        participationPolicy,
        status: "EVIDENCE_COMMITTED",
        evidence: [{ evidenceId: "evd_1", validationStatus: "COMMITTED" }],
        attestations: [{ statement: "PACKED_DESCRIBED_ITEM", attestedBy: "seller" }],
      });
      const api = apiMock([initial, committed]);
      const sequence: string[] = [];
      const signedAttestation = vi.fn(async (proofId: string, evidenceId: string) => {
        sequence.push(`signed:${proofId}:${evidenceId}`);
        expect(api.calls).toContain("commit:proof_1");
        return { proof: committed };
      });
      const prepareAttestation = vi.fn(async () => {
        expect(api.calls).toEqual([]);
        sequence.push("authorize");
        return signedAttestation;
      });
      const upload = vi.fn(async () => { sequence.push("upload"); });

      await submitStationSession({
        proof: initial, actorUserId: "seller", capture,
        deps: { api, upload, prepareAttestation, newIdempotencyKey: () => "signed" },
      });

      expect(sequence).toEqual(["authorize", "upload", "signed:proof_1:evd_1"]);
      expect(signedAttestation).toHaveBeenCalledExactlyOnceWith("proof_1", "evd_1");
      expect(api.calls.some((call) => call.startsWith("attest:"))).toBe(false);
    },
  );

  it("retains committed evidence and does not finalize if its signed attestation fails", async () => {
    const api = apiMock([snapshot()]);
    const signedAttestation = vi.fn(async () => {
      throw { code: "ATTESTATION_SIGNATURE_INVALID", message: "Authorization could not be verified." };
    });
    await expect(submitStationSession({
      proof: snapshot(), actorUserId: "seller", capture,
      deps: {
        api, upload: async () => undefined, newIdempotencyKey: () => "rejected",
        prepareAttestation: async () => signedAttestation,
      },
    })).rejects.toMatchObject({ code: "ATTESTATION_SIGNATURE_INVALID" });

    expect(api.calls).toContain("commit:proof_1");
    expect(api.calls.some((call) => call.startsWith("finalize:"))).toBe(false);
    expect(api.calls.some((call) => call.startsWith("attest:"))).toBe(false);
  });

  it("retries signed attestation for its persisted committed evidence without uploading again", async () => {
    const recovered = snapshot({
      status: "EVIDENCE_COMMITTED",
      evidence: [{ evidenceId: "evd_committed", validationStatus: "COMMITTED" }],
    });
    const api = apiMock([recovered]);
    const upload = vi.fn();
    const signedAttestation = vi.fn(async () => ({ proof: recovered }));

    const result = await submitStationSession({
      proof: recovered, actorUserId: "seller", capture,
      evidenceId: "evd_committed", idempotencyKey: "same-capture",
      deps: {
        api, upload, newIdempotencyKey: () => "unused",
        prepareAttestation: async () => signedAttestation,
      },
    });

    expect(result.evidenceId).toBe("evd_committed");
    expect(signedAttestation).toHaveBeenCalledExactlyOnceWith("proof_1", "evd_committed");
    expect(upload).not.toHaveBeenCalled();
    expect(api.calls.some((call) => call.startsWith("init:") || call.startsWith("commit:"))).toBe(false);
  });

  it("recovers a completed exact-evidence submission without creating a fresh authorization", async () => {
    const completed = snapshot({
      status: "FINALIZED",
      evidence: [{ evidenceId: "evd_committed", validationStatus: "COMMITTED" }],
    });
    const api = apiMock([completed]);
    const upload = vi.fn();
    const prepareAttestation = vi.fn();

    const result = await submitStationSession({
      proof: completed, actorUserId: "seller", capture, evidenceId: "evd_committed",
      deps: { api, upload, prepareAttestation, newIdempotencyKey: () => "recovered" },
    });

    expect(result.completion).toBe("FINALIZED");
    expect(prepareAttestation).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(api.calls).toEqual(["get:proof_1"]);
  });

  it("does not recover or attest another committed video when the evidence identity is missing", async () => {
    const api = apiMock([snapshot()]);
    api.initializeEvidenceUpload = async () => {
      throw { code: "EVIDENCE_ALREADY_COMMITTED", message: "Already committed" };
    };
    api.getProof = async () => snapshot({
      status: "EVIDENCE_COMMITTED",
      evidence: [{ evidenceId: "another-video", validationStatus: "COMMITTED" }],
    });
    const signedAttestation = vi.fn();
    const upload = vi.fn();

    await expect(submitStationSession({
      proof: snapshot(), actorUserId: "seller", capture,
      deps: {
        api, upload, newIdempotencyKey: () => "unknown-video",
        prepareAttestation: async () => signedAttestation,
      },
    })).rejects.toMatchObject({ code: "EVIDENCE_ALREADY_COMMITTED" });

    expect(signedAttestation).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });
});
