import path from "node:path";
import type { AppConfig } from "../config.js";
import { AwsS3ObjectStore } from "./aws-s3-object-store.js";
import { LocalObjectStore } from "./local-object-store.js";
import type { ObjectStore } from "./object-store.js";

export function createObjectStore(config: AppConfig): ObjectStore {
  if (config.objectStore === "s3") {
    if (!config.awsS3Bucket || !config.awsRegion) {
      throw new Error("AWS_S3_BUCKET and AWS_REGION are required for OBJECT_STORE=s3");
    }
    return new AwsS3ObjectStore(config.awsS3Bucket, config.awsRegion);
  }
  return new LocalObjectStore(
    path.join(config.pgliteDir, "objects"),
    config.publicBaseUrl,
    config.uploadSecret,
  );
}
