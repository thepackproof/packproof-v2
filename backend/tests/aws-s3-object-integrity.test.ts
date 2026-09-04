import { describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { sha256Hex } from "../src/hash.js";
import { AwsS3ObjectStore } from "../src/s3/aws-s3-object-store.js";

function fakeS3Get(bytes: Buffer): S3Client {
  return {
    send: async () => ({
      Body: {
        transformToByteArray: async () => Uint8Array.from(bytes),
      },
      ContentType: "video/mp4",
    }),
  } as unknown as S3Client;
}

describe("committed S3 object integrity", () => {
  it("serves bytes when the content-addressed key matches the object digest", async () => {
    const bytes = Buffer.from("immutable-evidence");
    const key = `evidence/proof_1/evd_1/committed/sha256-${sha256Hex(bytes)}`;
    const store = new AwsS3ObjectStore("evidence-bucket", {
      region: "us-east-1",
      client: fakeS3Get(bytes),
    });

    const result = await store.get(key);
    expect(result?.body.equals(bytes)).toBe(true);
  });

  it("fails closed if storage returns different bytes for a committed digest key", async () => {
    const expected = Buffer.from("original-evidence");
    const replaced = Buffer.from("different-evidence");
    const key = `evidence/proof_1/evd_1/committed/sha256-${sha256Hex(expected)}`;
    const store = new AwsS3ObjectStore("evidence-bucket", {
      region: "us-east-1",
      client: fakeS3Get(replaced),
    });

    await expect(store.get(key)).rejects.toMatchObject({
      code: "EVIDENCE_OBJECT_INTEGRITY_FAILURE",
      httpStatus: 500,
    });
  });
});
