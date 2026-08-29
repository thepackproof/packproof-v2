import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { sha256Hex } from "../src/hash.js";
import { AwsS3ObjectStore } from "../src/s3/aws-s3-object-store.js";

const enabled = process.env.PACKPROOF_S3_INTEGRATION === "1";

describe.skipIf(!enabled)("opt-in live S3 integration", () => {
  const config = loadConfig(process.env);
  const prefix = `evidence/_packproof_test/${Date.now()}/`;
  const client = new S3Client({ region: config.awsRegion });

  afterAll(async () => {
    if (!config.awsS3Bucket) {
      return;
    }
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: config.awsS3Bucket,
        Prefix: prefix,
      }),
    );
    const objects = (listed.Contents ?? [])
      .map((item) => item.Key)
      .filter((key): key is string => Boolean(key))
      .map((Key) => ({ Key }));
    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: config.awsS3Bucket,
          Delete: { Objects: objects },
        }),
      );
    }
  });

  it("puts, digests, and issues a presigned PUT for an isolated test prefix", async () => {
    if (!config.awsS3Bucket || !config.awsRegion || config.objectStore !== "s3") {
      throw new Error("Set PACKPROOF_S3_INTEGRATION=1 with PACKPROOF_OBJECT_STORAGE=s3");
    }
    const store = new AwsS3ObjectStore(config.awsS3Bucket, {
      region: config.awsRegion,
      expiresInSeconds: config.s3UploadExpiresSeconds,
      client,
    });
    const key = `${prefix}object`;
    const body = Buffer.from("live-s3-packproof-bytes");
    await store.put(key, body, "video/mp4");
    await expect(store.digest(key)).resolves.toEqual({
      sha256: sha256Hex(body),
      byteSize: body.byteLength,
      contentType: "video/mp4",
    });
    const target = await store.createUploadTarget({ key, contentType: "video/mp4" });
    expect(target.method).toBe("PUT");
    expect(target.url).toContain(config.awsS3Bucket);
    expect(target.url).toContain("X-Amz-Signature");
  });
});
