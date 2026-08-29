import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("storage configuration", () => {
  it("defaults to local and accepts PACKPROOF_OBJECT_STORAGE", () => {
    expect(loadConfig({}).objectStore).toBe("local");
    expect(loadConfig({ PACKPROOF_OBJECT_STORAGE: "local" }).objectStore).toBe("local");
    expect(
      loadConfig({
        PACKPROOF_OBJECT_STORAGE: "s3",
        PACKPROOF_S3_BUCKET: "packproof-v2-evidence",
        AWS_REGION: "us-east-1",
        PACKPROOF_S3_UPLOAD_EXPIRES_SECONDS: "900",
      }),
    ).toMatchObject({
      objectStore: "s3",
      awsS3Bucket: "packproof-v2-evidence",
      awsRegion: "us-east-1",
      s3UploadExpiresSeconds: 900,
    });
  });

  it("keeps OBJECT_STORE and AWS_S3_BUCKET as aliases", () => {
    expect(
      loadConfig({
        OBJECT_STORE: "s3",
        AWS_S3_BUCKET: "legacy-bucket",
        AWS_REGION: "us-west-2",
      }),
    ).toMatchObject({
      objectStore: "s3",
      awsS3Bucket: "legacy-bucket",
      awsRegion: "us-west-2",
    });
  });

  it("prefers explicit PACKPROOF_* names over aliases", () => {
    expect(
      loadConfig({
        PACKPROOF_OBJECT_STORAGE: "local",
        OBJECT_STORE: "s3",
        PACKPROOF_S3_BUCKET: "preferred",
        AWS_S3_BUCKET: "alias",
      }),
    ).toMatchObject({
      objectStore: "local",
      awsS3Bucket: "preferred",
    });
  });

  it("rejects hidden or invalid storage modes", () => {
    expect(() => loadConfig({ PACKPROOF_OBJECT_STORAGE: "auto" })).toThrow(
      /must be "local" or "s3"/,
    );
    expect(() => loadConfig({ PACKPROOF_S3_UPLOAD_EXPIRES_SECONDS: "0" })).toThrow(
      /PACKPROOF_S3_UPLOAD_EXPIRES_SECONDS/,
    );
  });
});
