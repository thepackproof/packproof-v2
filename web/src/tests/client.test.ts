import { describe, expect, it, vi } from "vitest";
import { joinUrl, PackProofApi } from "../api/client";
import { ApiError } from "../api/types";

describe("API client boundary", () => {
  it("joins same-origin and absolute API URLs", () => {
    expect(joinUrl("", "/me/proofs")).toBe("/me/proofs");
    expect(joinUrl("http://127.0.0.1:3000", "/proofs/abc")).toBe(
      "http://127.0.0.1:3000/proofs/abc",
    );
  });

  it("discards invitation tokens from create and accept responses", async () => {
    const fetchMock = async () =>
      new Response(
        JSON.stringify({
          invitation: {
            invitationId: "inv_1",
            proofId: "proof_1",
            inviteeIdentifier: "buyer-1",
            inviteeUserId: null,
            status: "PENDING",
            token: "should-not-escape",
            createdAt: "2026-08-30T12:00:00.000Z",
            acceptedAt: null,
            expiresAt: null,
          },
          proof: { proofId: "proof_1" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new PackProofApi({ baseUrl: "", getToken: () => "token" });
    const created = await api.createInvitation("proof_1", { inviteeIdentifier: "buyer-1" });
    expect(created.invitation).not.toHaveProperty("token");
    expect(JSON.stringify(created)).not.toContain("should-not-escape");
    vi.unstubAllGlobals();
  });

  it("requires a bearer token for authenticated reads", async () => {
    const api = new PackProofApi({ baseUrl: "", getToken: () => null });
    await expect(api.getProof("proof_1")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    } satisfies Partial<ApiError>);
  });
});
