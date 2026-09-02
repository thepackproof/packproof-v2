import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DomainError } from "../domain/errors.js";
import { sha256Hex } from "../hash.js";
import { assertSafeObjectKey, committedEvidenceObjectKey } from "./object-key.js";
import type {
  CommittedObject,
  ObjectDigest,
  ObjectStore,
  StoredObject,
  UploadTarget,
} from "./object-store.js";

export class LocalObjectStore implements ObjectStore {
  constructor(
    private readonly directory: string,
    private readonly publicBaseUrl: string,
    private readonly secret: string,
  ) {}

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const filePath = this.filePath(assertSafeObjectKey(key));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
    await writeFile(`${filePath}.meta.json`, JSON.stringify({ contentType }), "utf8");
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const filePath = this.filePath(assertSafeObjectKey(key));
      const body = await readFile(filePath);
      const meta = JSON.parse(await readFile(`${filePath}.meta.json`, "utf8")) as {
        contentType: string;
      };
      return { body, contentType: meta.contentType };
    } catch {
      return null;
    }
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
    await this.put(committedKey, stored.body, stored.contentType);
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
    const exp = Date.now() + 60 * 60 * 1000;
    const token = this.sign(assertSafeObjectKey(input.key), exp);
    return {
      method: "PUT",
      url: `${this.publicBaseUrl}/upload/${token}`,
      headers: { "Content-Type": input.contentType },
    };
  }

  async putUpload(
    token: string,
    body: Buffer,
    contentType: string | undefined,
  ): Promise<{ key: string }> {
    const { key } = this.verify(token);
    await this.put(assertSafeObjectKey(key), body, contentType ?? "application/octet-stream");
    return { key };
  }

  private filePath(key: string): string {
    const safe = key.replace(/\\/g, "/").split("/").filter((part) => part && part !== "..");
    return path.join(this.directory, ...safe);
  }

  private sign(key: string, exp: number): string {
    const payload = Buffer.from(JSON.stringify({ key, exp })).toString("base64url");
    const sig = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return `${payload}.${sig}`;
  }

  private verify(token: string): { key: string } {
    const [payload, sig] = token.split(".");
    if (!payload || !sig) {
      throw new DomainError("UPLOAD_TOKEN_INVALID", "Invalid upload token", 403);
    }
    const expected = createHmac("sha256", this.secret).update(payload).digest("base64url");
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      throw new DomainError("UPLOAD_TOKEN_INVALID", "Invalid upload token", 403);
    }
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      key: string;
      exp: number;
    };
    if (Date.now() > parsed.exp) {
      throw new DomainError("UPLOAD_TOKEN_EXPIRED", "Upload token expired", 403);
    }
    return { key: parsed.key };
  }
}
