import { describe, expect, it } from "vitest";
import { retentionPhaseFor, retentionPolicyFor } from "../src/domain/retention.js";

describe("evidence retention policy", () => {
  it("does not silently expire evidence in RC1", () => {
    for (const workflow of ["COMMERCE_SALE", "GRADING_SUBMISSION"] as const) {
      const policy = retentionPolicyFor(workflow);
      expect(policy.policyVersion).toBe(1);
      expect(policy.evidenceExpires).toBe(false);
      expect(policy.automaticEvidenceDeletion).toBe(false);
      expect(policy.minimumTamperProtectionDays).toBe(90);
      expect(policy.legalHoldSupported).toBe(true);
    }
  });

  it("models lifecycle state without making time-based deletion decisions", () => {
    expect(retentionPhaseFor({ finalizedAt: null, legalHold: false })).toBe("ACTIVE");
    expect(
      retentionPhaseFor({ finalizedAt: "2026-09-01T00:00:00.000Z", legalHold: false }),
    ).toBe("CLAIM_WINDOW");
    expect(
      retentionPhaseFor({
        finalizedAt: "2026-09-01T00:00:00.000Z",
        archivedAt: "2026-12-01T00:00:00.000Z",
        legalHold: false,
      }),
    ).toBe("ARCHIVED");
    expect(
      retentionPhaseFor({
        finalizedAt: "2026-09-01T00:00:00.000Z",
        archivedAt: "2026-12-01T00:00:00.000Z",
        legalHold: true,
      }),
    ).toBe("LEGAL_HOLD");
  });
});
