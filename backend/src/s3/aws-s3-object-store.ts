import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DomainError } from "../domain/errors.js";
import { sha256Hex, sha256HexFromStream } from "../hash.js";
import { assertSafeObjectKey, committedEvidenceObjectKey } from "./object-key.js";
import type {
  CommittedObject,
  ObjectDigest,
  ObjectStore,
  StoredObject,
  UploadTarget,
} from "./object-store.js";

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
      const body = Buffer.from(bytes);
      assertCommittedObjectDigest(objectKey, body);
      return {
        body,
        contentType: result.ContentType ?? "application/octet-stream",
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
      assertCommittedDigestValue(objectKey, hashed.sha256);
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

  async commitUpload(key: string): Promise<CommittedObject | null> {
    const sourceKey = assertSafeObjectKey(key);
    let expectedSize: number | undefined;
    let contentType = "application/octet-stream";
    let entityTag: string | undefined;
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: sourceKey }),
      );
      expectedSize = head.ContentLength;
      contentType = head.ContentType ?? contentType;
      entityTag = head.ETag;
    } catch (error) {
      if (isMissingS3Object(error)) {
        return null;
      }
      throw error;
    }
    if (!entityTag) {
      throw new DomainError(
        "EVIDENCE_OBJECT_SNAPSHOT_UNAVAILABLE",
        "Uploaded object cannot be committed without a stable storage identity",
        409,
      );
    }

    let hashed: { sha256: string; byteSize: number };
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: sourceKey,
          IfMatch: entityTag,
        }),
      );
      if (!result.Body) {
        return null;
      }
      hashed = await sha256HexFromStream(result.Body as AsyncIterable<Uint8Array>);
      contentType = result.ContentType ?? contentType;
    } catch (error) {
      if (isS3PreconditionFailure(error)) {
        throw uploadChangedError();
      }
      if (isMissingS3Object(error)) {
        return null;
      }
      throw error;
    }
    if (expectedSize != null && hashed.byteSize !== expectedSize) {
      throw new DomainError(
        "EVIDENCE_OBJECT_INCOMPLETE",
        "Uploaded object size does not match stored metadata",
        409,
      );
    }

    const committedKey = committedEvidenceObjectKey(sourceKey, hashed.sha256);
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: committedKey,
          CopySource: copySource(this.bucket, sourceKey),
          CopySourceIfMatch: entityTag,
          MetadataDirective: "COPY",
        }),
      );
    } catch (error) {
      if (isS3PreconditionFailure(error)) {
        throw uploadChangedError();
      }
      if (isMissingS3Object(error)) {
        return null;
      }
      throw error;
    }

    return {
      key: committedKey,
      sha256: hashed.sha256,
      byteSize: hashed.byteSize,
      contentType,
    };
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

function isS3PreconditionFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "PreconditionFailed" || candidate.$metadata?.httpStatusCode === 412;
}

function uploadChangedError(): DomainError {
  return new DomainError(
    "EVIDENCE_UPLOAD_CHANGED",
    "Uploaded object changed while it was being committed; retry the commit",
    409,
  );
}

function assertCommittedObjectDigest(key: string, body: Buffer): void {
  assertCommittedDigestValue(key, sha256Hex(body));
}

function assertCommittedDigestValue(key: string, actualSha256: string): void {
  const match = /\/committed\/sha256-([a-f0-9]{64})$/.exec(key);
  if (!match?.[1]) {
    return;
  }
  if (actualSha256.toLowerCase() !== match[1]) {
    throw new DomainError(
      "EVIDENCE_OBJECT_INTEGRITY_FAILURE",
      "Committed evidence bytes do not match their content-addressed SHA-256 key",
      500,
    );
  }
}

function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
}
