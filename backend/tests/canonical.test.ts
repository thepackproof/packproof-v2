import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical.js";
import { hashCanonicalManifest } from "../src/domain/finalize.js";

describe("canonical manifest hashing", () => {
  it("is deterministic regardless of object key insertion order", () => {
    const a = {
      manifestVersion: 1,
      proofId: "proof_1",
      participants: [
        { role: "BUYER", userId: "user_b" },
        { role: "SELLER", userId: "user_a" },
      ],
      evidence: [{ sha256: "abc", evidenceId: "evd_1" }],
    };
    const b = {
      evidence: [{ evidenceId: "evd_1", sha256: "abc" }],
      participants: [
        { userId: "user_b", role: "BUYER" },
        { userId: "user_a", role: "SELLER" },
      ],
      proofId: "proof_1",
      manifestVersion: 1,
    };
    const hashedA = hashCanonicalManifest(a);
    const hashedB = hashCanonicalManifest(b);
    expect(hashedA.canonicalJson).toBe(hashedB.canonicalJson);
    expect(hashedA.sha256).toBe(hashedB.sha256);
    expect(hashedA.sha256).toBe(
      createHash("sha256").update(canonicalize(a)).digest("hex"),
    );
  });
});
