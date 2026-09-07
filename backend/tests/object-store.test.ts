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

  it("streams immutable originals and rejects unreserved local upload tokens", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "packproof-local-store-"));
    dirs.push(dir);
    const store = new LocalObjectStore(path.join(dir, "objects"), "http://127.0.0.1:9", "secret");
    const key = "evidence/proof_1/evd_1/object";
    const body = Buffer.from("local-bytes");
    await store.put(key, body, "video/mp4");
    const stored = await store.get(key);
    expect(stored?.contentType).toBe("video/mp4");
    expect(stored?.body.equals(body)).toBe(true);
    await expect(store.digest(key)).resolves.toMatchObject({
      sha256: sha256Hex(body),
      byteSize: body.byteLength,
      contentType: "video/mp4",
    });
    const committed = await store.commitUpload(key);
    expect(committed?.key).toBe(
      `evidence/proof_1/evd_1/committed/sha256-${sha256Hex(body)}`,
    );
    expect((await store.get(committed!.key))?.body.equals(body)).toBe(true);

    await expect(store.createUploadTarget()).rejects.toMatchObject({code:"UPLOAD_ADMISSION_REQUIRED"});
    await expect(store.putUpload()).rejects.toMatchObject({code:"UPLOAD_ADMISSION_REQUIRED"});
    await store.put(key,Buffer.from("replaced"),"video/mp4");
    expect((await store.get(committed!.key,{versionId:committed!.versionId}))?.body.equals(body)).toBe(true);
  });
});

describe("AwsS3ObjectStore", () => {
  it.each(["recovery/v1/proof/event.json", "recovery/policy/v1/00000000000000000001.json"])(
    "routes protected journal key %s through the preserved bucket",
    async (key) => {
      const commands: Array<PutObjectCommand | HeadObjectCommand | GetObjectCommand> = [];
      const client = {
        send: async (command: PutObjectCommand | HeadObjectCommand | GetObjectCommand) => {
          commands.push(command);
          if (command instanceof PutObjectCommand) return { VersionId: "journal-version" };
          return {
            ContentLength: 2,
            ContentType: "application/json",
            VersionId: "journal-version",
            Body: Readable.from([Buffer.from("{}")]),
          };
        },
      } as unknown as S3Client;
      const store = new AwsS3ObjectStore("staging", {
        region: "us-east-1", client, committedBucket: "preserved",
      });
      await expect(store.putIfAbsent(key, Buffer.from("{}"), "application/json"))
        .resolves.toEqual({ created: true });
      await store.head(key, { versionId: "journal-version" });
      const streamed = await store.getStream(key, { versionId: "journal-version" });
      streamed?.body.destroy();
      expect(commands).toHaveLength(3);
      expect(commands.every(command => command.input.Bucket === "preserved" && command.input.Key === key)).toBe(true);
      expect((commands[0] as PutObjectCommand).input.IfNoneMatch).toBe("*");
      expect((commands[1] as HeadObjectCommand).input.VersionId).toBe("journal-version");
      expect((commands[2] as GetObjectCommand).input.VersionId).toBe("journal-version");
      await expect(store.putStream(key, Readable.from([Buffer.from("{}")]), "application/json", 2))
        .rejects.toMatchObject({ code: "STAGING_KEY_REQUIRED" });
      await expect(store.deleteStaging(key)).rejects.toMatchObject({ code: "STAGING_KEY_REQUIRED" });
      expect(commands).toHaveLength(3);
    },
  );

  it("pins S3 versions and rejects direct presigned PUT authorization", async () => {
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
            VersionId: command.input.Key?.includes("/committed/") ? "committed-version" : "stage-version",
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
            ContentLength: stored.body.length,
            VersionId: command.input.VersionId ?? "stage-version",
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
          const source = decodeURIComponent((command.input.CopySource ?? "").split("?versionId=")[0]).replace(
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
          expect(command.input.CopySource).toContain("?versionId=stage-version");
          objects.set(command.input.Key ?? "", {
            body: Buffer.from(stored.body),
            contentType: stored.contentType,
          });
          return {VersionId:"committed-version"};
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
    await expect(store.digest(key)).resolves.toMatchObject({
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

    expect(committed?.versionId).toBe("committed-version");
    expect(committed?.stagingVersionId).toBe("stage-version");
    expect((await store.commitUpload(key))?.versionId).toBe(committed?.versionId);
    await expect(store.createUploadTarget()).rejects.toMatchObject({code:"UPLOAD_ADMISSION_REQUIRED"});
    await expect(store.putUpload()).rejects.toMatchObject({code:"UPLOAD_ADMISSION_REQUIRED"});
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
