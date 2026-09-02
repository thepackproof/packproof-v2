import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError } from "../src/domain/errors.js";
import { sha256Hex } from "../src/hash.js";
import { AwsS3ObjectStore } from "../src/s3/aws-s3-object-store.js";
import { createObjectStore } from "../src/s3/create-object-store.js";
import { LocalObjectStore } from "../src/s3/local-object-store.js";
import {
  assertSafeObjectKey,
  committedEvidenceObjectKey,
  evidenceObjectKey,
} from "../src/s3/object-key.js";
import { loadConfig } from "../src/config.js";

describe("object key rules", () => {
  it("builds opaque server-side evidence keys and rejects traversal", () => {
    expect(evidenceObjectKey("proof_01ABC", "evd_01DEF")).toBe(
      "evidence/proof_01ABC/evd_01DEF/object",
    );
    expect(committedEvidenceObjectKey(
      "evidence/proof_01ABC/evd_01DEF/object",
      "a".repeat(64),
    )).toBe(`evidence/proof_01ABC/evd_01DEF/committed/sha256-${"a".repeat(64)}`);
    expect(() => evidenceObjectKey("../etc", "evd_01DEF")).toThrowError(DomainError);
    expect(() => assertSafeObjectKey("evidence/../secret")).toThrowError(DomainError);
    expect(() => assertSafeObjectKey("/absolute/key")).toThrowError(DomainError);
  });
});

describe("LocalObjectStore", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("implements put, get, digest, and local upload tokens", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "packproof-local-store-"));
    dirs.push(dir);
    const store = new LocalObjectStore(path.join(dir, "objects"), "http://127.0.0.1:9", "secret");
    const key = "evidence/proof_1/evd_1/object";
    const body = Buffer.from("local-bytes");
    await store.put(key, body, "video/mp4");
    const stored = await store.get(key);
    expect(stored?.contentType).toBe("video/mp4");
    expect(stored?.body.equals(body)).toBe(true);
    await expect(store.digest(key)).resolves.toEqual({
      sha256: sha256Hex(body),
      byteSize: body.byteLength,
      contentType: "video/mp4",
    });
    const committed = await store.commitUpload(key);
    expect(committed?.key).toBe(
      `evidence/proof_1/evd_1/committed/sha256-${sha256Hex(body)}`,
    );
    expect((await store.get(committed!.key))?.body.equals(body)).toBe(true);

    const target = await store.createUploadTarget({ key, contentType: "video/mp4" });
    expect(target.method).toBe("PUT");
    expect(target.url).toContain("/upload/");
    const token = new URL(target.url).pathname.replace("/upload/", "");
    const uploaded = await store.putUpload(token, Buffer.from("replaced"), "video/mp4");
    expect(uploaded.key).toBe(key);
    await expect(store.digest(key)).resolves.toMatchObject({
      sha256: sha256Hex(Buffer.from("replaced")),
      byteSize: 8,
    });
  });
});

describe("AwsS3ObjectStore", () => {
  it("implements the ObjectStore interface with scoped presigned PUT authorization", async () => {
    const objects = new Map<string, { body: Buffer; contentType: string }>();
    const client = {
      send: async (command: unknown) => {
        if (command instanceof HeadObjectCommand) {
          const stored = objects.get(command.input.Key ?? "");
          if (!stored) {
            throw Object.assign(new Error("missing"), {
              name: "NotFound",
              $metadata: { httpStatusCode: 404 },
            });
          }
          return {
            ContentLength: stored.body.byteLength,
            ContentType: stored.contentType,
            ETag: `"${sha256Hex(stored.body)}"`,
          };
        }
        if (command instanceof GetObjectCommand) {
          const stored = objects.get(command.input.Key ?? "");
          if (!stored) {
            throw Object.assign(new Error("missing"), {
              name: "NoSuchKey",
              $metadata: { httpStatusCode: 404 },
            });
          }
          return {
            ContentType: stored.contentType,
            Body: Readable.from(stored.body),
          };
        }
        if (command instanceof PutObjectCommand) {
          const body = Buffer.isBuffer(command.input.Body)
            ? command.input.Body
            : Buffer.from(String(command.input.Body ?? ""));
          objects.set(command.input.Key ?? "", {
            body,
            contentType: command.input.ContentType ?? "application/octet-stream",
          });
          return {};
        }
        if (command instanceof CopyObjectCommand) {
          const source = decodeURIComponent(command.input.CopySource ?? "").replace(
            /^packproof-test\//,
            "",
          );
          const stored = objects.get(source);
          if (!stored) {
            throw Object.assign(new Error("missing"), {
              name: "NoSuchKey",
              $metadata: { httpStatusCode: 404 },
            });
          }
          objects.set(command.input.Key ?? "", {
            body: Buffer.from(stored.body),
            contentType: stored.contentType,
          });
          return {};
        }
        throw new Error(`unexpected command ${command?.constructor?.name}`);
      },
    } as unknown as S3Client;

    const store = new AwsS3ObjectStore("packproof-test", {
      region: "us-east-1",
      expiresInSeconds: 900,
      client,
      signPutUrl: async ({ key, contentType, expiresInSeconds }) =>
        `https://packproof-test.s3.us-east-1.amazonaws.com/${key}?expires=${expiresInSeconds}&ct=${encodeURIComponent(contentType)}`,
    });

    const key = "evidence/proof_01A/evd_01B/object";
    await expect(store.digest(key)).resolves.toBeNull();
    await store.put(key, Buffer.from("s3-bytes"), "video/mp4");
    await expect(store.digest(key)).resolves.toEqual({
      sha256: sha256Hex(Buffer.from("s3-bytes")),
      byteSize: 8,
      contentType: "video/mp4",
    });
    const committed = await store.commitUpload(key);
    expect(committed).toMatchObject({
      key: `evidence/proof_01A/evd_01B/committed/sha256-${sha256Hex(Buffer.from("s3-bytes"))}`,
      sha256: sha256Hex(Buffer.from("s3-bytes")),
      byteSize: 8,
      contentType: "video/mp4",
    });
    expect(objects.get(committed!.key)?.body.toString()).toBe("s3-bytes");

    const target = await store.createUploadTarget({ key, contentType: "video/mp4" });
    expect(target.method).toBe("PUT");
    expect(target.url).toContain(key);
    expect(target.url).toContain("expires=900");
    expect(target.headers["Content-Type"]).toBe("video/mp4");
    await expect(store.putUpload("token", Buffer.from("x"), "video/mp4")).rejects.toMatchObject({
      code: "UPLOAD_NOT_LOCAL",
    });
  });

  it("rejects an incomplete object when streamed bytes do not match HeadObject size", async () => {
    const client = {
      send: async (command: unknown) => {
        if (command instanceof HeadObjectCommand) {
          return { ContentLength: 12, ContentType: "video/mp4" };
        }
        if (command instanceof GetObjectCommand) {
          return { ContentType: "video/mp4", Body: Readable.from(Buffer.from("short")) };
        }
        throw new Error("unexpected");
      },
    } as unknown as S3Client;
    const store = new AwsS3ObjectStore("packproof-test", { region: "us-east-1", client });
    await expect(store.digest("evidence/proof_01A/evd_01B/object")).rejects.toMatchObject({
      code: "EVIDENCE_OBJECT_INCOMPLETE",
    });
  });
});

describe("createObjectStore", () => {
  it("selects local storage unless PACKPROOF_OBJECT_STORAGE=s3", () => {
    const local = createObjectStore(
      loadConfig({
        PACKPROOF_OBJECT_STORAGE: "local",
        PGLITE_DIR: path.join(os.tmpdir(), "packproof-unused"),
      }),
    );
    expect(local).toBeInstanceOf(LocalObjectStore);

    const s3 = createObjectStore(
      loadConfig({
        PACKPROOF_OBJECT_STORAGE: "s3",
        PACKPROOF_S3_BUCKET: "packproof-v2-evidence",
        AWS_REGION: "us-east-1",
      }),
    );
    expect(s3).toBeInstanceOf(AwsS3ObjectStore);
  });

  it("does not infer S3 from AWS credentials alone", () => {
    const store = createObjectStore(
      loadConfig({
        AWS_ACCESS_KEY_ID: "AKIATEST",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_REGION: "us-east-1",
        PACKPROOF_S3_BUCKET: "should-not-select-s3",
        PGLITE_DIR: path.join(os.tmpdir(), "packproof-unused"),
      }),
    );
    expect(store).toBeInstanceOf(LocalObjectStore);
  });
});
