import { describe, expect, it, vi } from "vitest";
import { submitStationSession, type StationSubmitApi } from "../../mobile/src/packing-station/submit.ts";
import type { StationProofSnapshot } from "../../mobile/src/packing-station/types.ts";
import type { CachedClientState } from "../../mobile/src/session.ts";
import { mergeRefreshedSession, sessionForReauthentication } from "../../mobile/src/session-recovery.ts";
import { isAuthenticationFailure } from "../../mobile/src/copy/errors.ts";
import { filterProofInvitations } from "../../mobile/src/copy/presentation.ts";
import { DEFAULT_PROOFS_LIBRARY } from "../../mobile/src/app/navigation.ts";
import { initialStationState, reduceStation } from "../../mobile/src/packing-station/machine.ts";

const capture = { handle: "file://packing.mp4", contentType: "video/mp4", byteSize: 12, durationMs: 3000 };
const ready = (): StationProofSnapshot => ({
  proofId: "proof_one", transactionId: "txn_one", status: "READY_FOR_EVIDENCE",
  participationPolicy: "COUNTERPARTY_OPTIONAL", participants: [{ userId: "seller", role: "SELLER" }],
  evidence: [], attestations: [], transaction: {},
});

describe("station recovery across a lost response and restart", () => {
  it.each(["commit", "attest", "finalize"])("resumes after the %s response is lost using the persisted evidence identity", async (failedStep) => {
    let server = ready();
    let savedEvidenceId: string | null = null;
    let responseLost = false;
    const loseResponse = (step: string) => {
      if (step === failedStep && !responseLost) {
        responseLost = true;
        throw new TypeError("Network request failed");
      }
    };
    const api: StationSubmitApi = {
      initializeEvidenceUpload: vi.fn(async () => ({
        evidenceId: "evidence_one", upload: { method: "PUT", url: "https://upload.example/one", headers: {} },
      })),
      commitEvidence: vi.fn(async () => {
        server = { ...server, status: "EVIDENCE_COMMITTED", evidence: [{ evidenceId: "evidence_one", validationStatus: "COMMITTED", evidenceType: "FULFILLMENT_CAPTURE" }] };
        loseResponse("commit");
        return { proof: server };
      }),
      createAttestation: vi.fn(async () => {
        server = { ...server, attestations: [{ statement: "PACKED_DESCRIBED_ITEM", attestedBy: "seller" }] };
        loseResponse("attest");
        return { proof: server };
      }),
      finalizeProof: vi.fn(async () => {
        server = { ...server, status: "FINALIZED" };
        loseResponse("finalize");
        return { proof: server };
      }),
      getProof: vi.fn(async () => server),
    };
    const upload = vi.fn(async () => { expect(savedEvidenceId).toBe("evidence_one"); });
    const deps = { api, upload, newIdempotencyKey: () => "unused" };
    await expect(submitStationSession({
      proof: ready(), actorUserId: "seller", capture, idempotencyKey: "recording_one", deps,
      onEvidenceInitialized: async (id) => { savedEvidenceId = id; },
    })).rejects.toBeDefined();
    // Simulate a new screen after restart: it receives the latest server snapshot
    // plus only the evidence identity persisted before the upload.
    const result = await submitStationSession({
      proof: await api.getProof("proof_one"), actorUserId: "seller", capture,
      idempotencyKey: "recording_one", evidenceId: savedEvidenceId, deps,
    });
    expect(result.completion).toBe("FINALIZED");
    expect(result.evidenceId).toBe("evidence_one");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(api.initializeEvidenceUpload).toHaveBeenCalledTimes(1);
    expect(api.commitEvidence).toHaveBeenCalledTimes(1);
    expect(api.createAttestation).toHaveBeenCalledTimes(1);
    expect(api.finalizeProof).toHaveBeenCalledTimes(1);
  });

  it("keeps another recording's committed evidence out of recovery", async () => {
    const upload = vi.fn();
    await expect(submitStationSession({
      proof: { ...ready(), status: "EVIDENCE_COMMITTED", evidence: [{ evidenceId: "other_recording", validationStatus: "COMMITTED" }] },
      actorUserId: "seller", capture, evidenceId: "our_recording", idempotencyKey: "our_key",
      deps: { api: {} as StationSubmitApi, upload, newIdempotencyKey: () => "unused" },
    })).rejects.toMatchObject({ code: "EVIDENCE_ALREADY_COMMITTED" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("does not upload if the recovery identity cannot be persisted", async () => {
    const upload = vi.fn();
    const commitEvidence = vi.fn();
    await expect(submitStationSession({
      proof: ready(), actorUserId: "seller", capture,
      onEvidenceInitialized: async () => { throw new Error("Device storage is full"); },
      deps: {
        api: { initializeEvidenceUpload: async () => ({ evidenceId: "evidence_one", upload: { method: "PUT", url: "https://upload.example", headers: {} } }), commitEvidence } as unknown as StationSubmitApi,
        upload, newIdempotencyKey: () => "recording_one",
      },
    })).rejects.toBeDefined();
    expect(upload).not.toHaveBeenCalled();
    expect(commitEvidence).not.toHaveBeenCalled();
  });
});

const cached = (): CachedClientState => ({
  apiBaseUrl: "https://api.example", authMode: "cognito", subject: "seller@example.com", email: "seller@example.com",
  userId: "seller", username: "seller", displayName: "Seller", token: "expired-access", refreshToken: "refresh", idToken: "expired-id", accessExpiresAt: 1,
  cognitoUserPoolId: "pool", cognitoClientId: "client", cognitoRegion: "us-east-1",
  proofId: "proof_one", transactionId: "txn_one", invitationToken: null,
  captureUri: "file://packing.mp4", captureProofId: "proof_one", evidenceIdempotencyKey: "recording_one", uploadEvidenceId: "evidence_one",
  evidenceContentType: "video/mp4", captureByteSize: 12, captureDurationMs: 3000,
  stationActive: true, stationPhase: "active", stationProofId: "proof_one", stationTransactionId: "txn_one", stationOrderLabel: "Order one", stationItemSummary: "Card",
});
const refreshed = { accessToken: "fresh-access", refreshToken: "fresh-refresh", idToken: "fresh-id", expiresAt: 999999 };

describe("mobile authentication preserves recording recovery", () => {
  it("removes expired credentials while preserving recording ownership and resume state", () => {
    const expired = sessionForReauthentication(cached());
    expect(expired).toMatchObject({ token: "", refreshToken: null, idToken: null, needsReauthentication: true,
      userId: "seller", captureUri: "file://packing.mp4", captureProofId: "proof_one", uploadEvidenceId: "evidence_one", evidenceIdempotencyKey: "recording_one", stationActive: true });
    expect(JSON.parse(JSON.stringify(expired))).toEqual(expired);
  });

  it("merges fresh credentials into capture state changed during a refresh", () => {
    const started = cached();
    const current = { ...started, captureUri: "file://replacement.mp4", evidenceIdempotencyKey: "replacement", uploadEvidenceId: "replacement_evidence" };
    expect(mergeRefreshedSession(current, started, refreshed)).toMatchObject({
      token: "fresh-access", captureUri: "file://replacement.mp4", evidenceIdempotencyKey: "replacement", uploadEvidenceId: "replacement_evidence",
    });
  });

  it.each([null, { ...cached(), userId: "another_user" }, { ...cached(), token: "new-sign-in" }, sessionForReauthentication(cached())])("does not revive a session replaced while refreshing", (current) => {
    expect(mergeRefreshedSession(current, cached(), refreshed)).toBeNull();
  });

  it("treats a denied operation as authorization failure without signing the user out", () => {
    expect(isAuthenticationFailure({ status: 403, code: "PARTICIPANT_NOT_AUTHORIZED" })).toBe(false);
    expect(isAuthenticationFailure({ status: 401, code: "UNAUTHENTICATED" })).toBe(true);
    expect(isAuthenticationFailure({ code: "NotAuthorizedException" })).toBe(true);
  });
});

describe("mobile invitation discovery", () => {
  const invitations = [{ transaction: { itemTitle: "Rare Card" }, inviter: { displayName: "Collin", username: "seller" } }];
  it("shows pending invitations with the default All role filter", () => {
    expect(filterProofInvitations(invitations, DEFAULT_PROOFS_LIBRARY)).toEqual(invitations);
  });
  it("matches the item and sender while respecting explicit filters", () => {
    expect(filterProofInvitations(invitations, { ...DEFAULT_PROOFS_LIBRARY, query: " COLLIn " })).toEqual(invitations);
    expect(filterProofInvitations(invitations, { ...DEFAULT_PROOFS_LIBRARY, query: "missing" })).toEqual([]);
    expect(filterProofInvitations(invitations, { ...DEFAULT_PROOFS_LIBRARY, view: "completed" })).toEqual([]);
    expect(filterProofInvitations(invitations, { ...DEFAULT_PROOFS_LIBRARY, role: "seller" })).toEqual([]);
    expect(filterProofInvitations(invitations, { ...DEFAULT_PROOFS_LIBRARY, carrier: "UPS" })).toEqual([]);
  });
});

it("returns the station to recovery when camera permission or local capture fails", () => {
  const state = { ...initialStationState(), phase: "RECORDING" as const };
  expect(reduceStation(state, {
    type: "OPERATION_FAILED", error: { code: "CAPTURE_FAILED", message: "Camera denied" }, canRetry: false,
  })).toMatchObject({ phase: "RECOVERY", error: { code: "CAPTURE_FAILED" }, canRetry: false });
});
