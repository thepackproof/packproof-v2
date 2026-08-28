import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DomainError } from "../domain/errors.js";
import type { ObjectStore, StoredObject, UploadTarget } from "./object-store.js";

export class AwsS3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
  ) {
    this.client = new S3Client({ region });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = await result.Body?.transformToByteArray();
      if (!bytes) {
        return null;
      }
      return {
        body: Buffer.from(bytes),
        contentType: result.ContentType ?? "application/octet-stream",
      };
    } catch {
      return null;
    }
  }

  async createUploadTarget(input: {
    key: string;
    contentType: string;
  }): Promise<UploadTarget> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ContentType: input.contentType,
      }),
      { expiresIn: 3600 },
    );
    return {
      method: "PUT",
      url,
      headers: { "Content-Type": input.contentType },
    };
  }

  async putUpload(): Promise<{ key: string }> {
    throw new DomainError(
      "UPLOAD_NOT_LOCAL",
      "S3 uploads must use the signed object URL",
      400,
    );
  }
}
