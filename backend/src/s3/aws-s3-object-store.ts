import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DomainError } from "../domain/errors.js";
import { sha256HexFromStream } from "../hash.js";
import { assertSafeObjectKey } from "./object-key.js";
import type { ObjectDigest, ObjectStore, StoredObject, UploadTarget } from "./object-store.js";

export interface AwsS3ObjectStoreOptions {
  region: string;
  expiresInSeconds?: number;
  client?: S3Client;
  signPutUrl?: (input: {
    key: string;
    contentType: string;
    expiresInSeconds: number;
  }) => Promise<string>;
}

export class AwsS3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly expiresInSeconds: number;
  private readonly signPutUrl?: AwsS3ObjectStoreOptions["signPutUrl"];

  constructor(
    private readonly bucket: string,
    options: AwsS3ObjectStoreOptions,
  ) {
    this.client = options.client ?? new S3Client({ region: options.region });
    this.expiresInSeconds = options.expiresInSeconds ?? 3600;
    this.signPutUrl = options.signPutUrl;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const objectKey = assertSafeObjectKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    const objectKey = assertSafeObjectKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      const bytes = await result.Body?.transformToByteArray();
      if (!bytes) {
        return null;
      }
      return {
        body: Buffer.from(bytes),
        contentType: result.ContentType ?? "application/octet-stream",
      };
    } catch (error) {
      if (isMissingS3Object(error)) {
        return null;
      }
      throw error;
    }
  }

  async digest(key: string): Promise<ObjectDigest | null> {
    const objectKey = assertSafeObjectKey(key);
    let expectedSize: number | undefined;
    let contentType = "application/octet-stream";
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      expectedSize = head.ContentLength;
      if (head.ContentType) {
        contentType = head.ContentType;
      }
    } catch (error) {
      if (isMissingS3Object(error)) {
        return null;
      }
      throw error;
    }

    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      if (!result.Body) {
        return null;
      }
      const hashed = await sha256HexFromStream(result.Body as AsyncIterable<Uint8Array>);
      if (expectedSize != null && hashed.byteSize !== expectedSize) {
        throw new DomainError(
          "EVIDENCE_OBJECT_INCOMPLETE",
          "Uploaded object size does not match stored metadata",
          409,
        );
      }
      return {
        sha256: hashed.sha256,
        byteSize: hashed.byteSize,
        contentType: result.ContentType ?? contentType,
      };
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      if (isMissingS3Object(error)) {
        return null;
      }
      throw error;
    }
  }

  async createUploadTarget(input: {
    key: string;
    contentType: string;
  }): Promise<UploadTarget> {
    const objectKey = assertSafeObjectKey(input.key);
    const url = this.signPutUrl
      ? await this.signPutUrl({
          key: objectKey,
          contentType: input.contentType,
          expiresInSeconds: this.expiresInSeconds,
        })
      : await getSignedUrl(
          this.client,
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: objectKey,
            ContentType: input.contentType,
          }),
          { expiresIn: this.expiresInSeconds },
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

export function isMissingS3Object(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.name === "NotFoundException" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}
