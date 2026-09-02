import { DomainError } from "../src/domain/errors.js";
import { sha256Hex } from "../src/hash.js";
import { assertSafeObjectKey, committedEvidenceObjectKey } from "../src/s3/object-key.js";
import type {
  CommittedObject,
  ObjectDigest,
  ObjectStore,
  StoredObject,
  UploadTarget,
} from "../src/s3/object-store.js";

export class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, StoredObject>();
  readonly uploadTargets: UploadTarget[] = [];

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(assertSafeObjectKey(key), {
      body: Buffer.from(body),
      contentType,
    });
  }

  async get(key: string): Promise<StoredObject | null> {
    const stored = this.objects.get(assertSafeObjectKey(key));
    if (!stored) {
      return null;
    }
    return { body: Buffer.from(stored.body), contentType: stored.contentType };
  }

  async digest(key: string): Promise<ObjectDigest | null> {
    const stored = await this.get(key);
    if (!stored) {
      return null;
    }
    return {
      sha256: sha256Hex(stored.body),
      byteSize: stored.body.byteLength,
      contentType: stored.contentType,
    };
  }

  async commitUpload(key: string): Promise<CommittedObject | null> {
    const stored = await this.get(key);
    if (!stored) {
      return null;
    }
    const sha256 = sha256Hex(stored.body);
    const committedKey = committedEvidenceObjectKey(key, sha256);
    this.objects.set(committedKey, {
      body: Buffer.from(stored.body),
      contentType: stored.contentType,
    });
    return {
      key: committedKey,
      sha256,
      byteSize: stored.body.byteLength,
      contentType: stored.contentType,
    };
  }

  async createUploadTarget(input: {
    key: string;
    contentType: string;
  }): Promise<UploadTarget> {
    const key = assertSafeObjectKey(input.key);
    const target: UploadTarget = {
      method: "PUT",
      url: `https://s3.test/${encodeURIComponent(key)}?sig=${this.uploadTargets.length}`,
      headers: { "Content-Type": input.contentType },
    };
    this.uploadTargets.push(target);
    return target;
  }

  async putUpload(): Promise<{ key: string }> {
    throw new DomainError(
      "UPLOAD_NOT_LOCAL",
      "S3 uploads must use the signed object URL",
      400,
    );
  }
}
