import { afterEach, describe, expect, it } from "vitest";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { createTransaction } from "../src/domain/transactions.js";
import { createHarness, createUser, type TestHarness } from "./helpers.js";

describe("persisted workflow protocol version", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("stores v1 on existing workflow types and rejects reinterpretation", async () => {
    harness = await createHarness();
    const seller = await createUser(harness);
    const transaction = await createTransaction(harness.db, harness.clock, seller, {
      externalReference: "WORKFLOW-VERSION-1",
      itemTitle: "Versioned item",
    });
    const proof = await createOrGetProof(
      harness.db,
      harness.clock,
      seller,
      transaction.transactionId,
    );

    const stored = await harness.db.query<{ workflow_type: string; workflow_version: number }>(
      `SELECT workflow_type, workflow_version FROM proofs WHERE id = $1`,
      [proof.proofId],
    );
    expect(stored.rows[0]).toMatchObject({
      workflow_type: "COMMERCE_SALE",
      workflow_version: 1,
    });

    await expect(
      harness.db.query(`UPDATE proofs SET workflow_version = 2 WHERE id = $1`, [proof.proofId]),
    ).rejects.toThrow(/WORKFLOW_VERSION_IMMUTABLE/);
  });
});
