import { describe, expect, it } from "vitest";
import { evaluateFinalizeRequirements } from "../src/domain/finalize-requirements.js";
import { isQualifyingFulfillmentCapture, parseEvidenceType } from "../src/domain/evidence-types.js";
import { DomainError } from "../src/domain/errors.js";

const merchantBase = {
  participationPolicy: "COUNTERPARTY_OPTIONAL" as const,
  proofStatus: "READY_FOR_EVIDENCE",
  hasSeller: true,
  hasBuyer: false,
  pendingEvidenceCount: 0,
  committedEvidenceCount: 0,
  committedFulfillmentCaptureCount: 0,
  packingAttested: true,
};

describe("evaluateFinalizeRequirements", () => {
  it("rejects merchant finalization without qualifying fulfillment capture", () => {
    const result = evaluateFinalizeRequirements(merchantBase);
    expect(result).toEqual({
      ok: false,
      code: "FULFILLMENT_CAPTURE_REQUIRED",
      message: "Packing evidence is required before this Proof can be finalized.",
    });
  });

  it("does not treat generic committed evidence as merchant capture", () => {
    const result = evaluateFinalizeRequirements({
      ...merchantBase,
      proofStatus: "EVIDENCE_COMMITTED",
      committedEvidenceCount: 1,
      committedFulfillmentCaptureCount: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FULFILLMENT_CAPTURE_REQUIRED");
    }
  });

  it("allows merchant finalization when capture and attestation are present", () => {
    expect(
      evaluateFinalizeRequirements({
        ...merchantBase,
        proofStatus: "EVIDENCE_COMMITTED",
        committedEvidenceCount: 1,
        committedFulfillmentCaptureCount: 1,
        packingAttested: true,
      }),
    ).toEqual({ ok: true });
  });

  it("keeps P2P finalization independent of fulfillment capture type", () => {
    expect(
      evaluateFinalizeRequirements({
        participationPolicy: "COUNTERPARTY_REQUIRED",
        proofStatus: "EVIDENCE_COMMITTED",
        hasSeller: true,
        hasBuyer: true,
        pendingEvidenceCount: 0,
        committedEvidenceCount: 1,
        committedFulfillmentCaptureCount: 0,
        packingAttested: false,
      }),
    ).toEqual({ ok: true });
  });
});

describe("evidence purpose", () => {
  it("accepts only declared evidence types", () => {
    expect(parseEvidenceType(undefined)).toBe("SELLER_EVIDENCE");
    expect(parseEvidenceType("FULFILLMENT_CAPTURE")).toBe("FULFILLMENT_CAPTURE");
    expect(() => parseEvidenceType("video/mp4")).toThrow(DomainError);
    expect(() => parseEvidenceType("PACKING_VIDEO")).toThrow(DomainError);
  });

  it("qualifies only committed fulfillment capture, not MIME or filename", () => {
    expect(
      isQualifyingFulfillmentCapture({
        evidenceType: "FULFILLMENT_CAPTURE",
        validationStatus: "COMMITTED",
      }),
    ).toBe(true);
    expect(
      isQualifyingFulfillmentCapture({
        evidenceType: "SELLER_EVIDENCE",
        validationStatus: "COMMITTED",
      }),
    ).toBe(false);
    expect(
      isQualifyingFulfillmentCapture({
        evidenceType: "FULFILLMENT_CAPTURE",
        validationStatus: "PENDING",
      }),
    ).toBe(false);
  });
});
