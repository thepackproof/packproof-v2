import path from "node:path";
import type { AppConfig } from "../config.js";
import { AwsS3ObjectStore } from "./aws-s3-object-store.js";
import { LocalObjectStore } from "./local-object-store.js";
import type { ObjectStore } from "./object-store.js";

export function createObjectStore(config: AppConfig): ObjectStore {
  if (config.objectStore === "s3") {
    if (!config.awsS3Bucket || !config.awsRegion) {
      throw new Error(
        "PACKPROOF_S3_BUCKET (or AWS_S3_BUCKET) and AWS_REGION are required when PACKPROOF_OBJECT_STORAGE=s3",
      );
    }
    return new AwsS3ObjectStore(config.awsS3Bucket, {
      region: config.awsRegion,
      expiresInSeconds: config.s3UploadExpiresSeconds,
    });
  }
  return new LocalObjectStore(
    path.join(config.pgliteDir, "objects"),
    config.publicBaseUrl,
    config.uploadSecret,
  );
}
