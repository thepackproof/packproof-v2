import { describe, expect, it } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { createHash } from 'node:crypto';
import { sha256Hex } from "../src/hash.js";
import { AwsS3ObjectStore } from "../src/s3/aws-s3-object-store.js";

function fakeS3Get(bytes: Buffer): S3Client {
  return {
    send: async () => ({
      Body: {
        transformToByteArray: async () => Uint8Array.from(bytes),
      },
      ContentType: "video/mp4",
    }),
  } as unknown as S3Client;
}

describe("committed S3 object integrity", () => {
  it('serializes Object Lock compatible checksums and conditional creation for protected journal writes', async () => {
    const sent: Array<{headers: Record<string,string>; body: unknown; path: string}> = [];
    const client = new S3Client({
      region: 'us-east-1', requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: {accessKeyId: 'synthetic-test-only', secretAccessKey: 'synthetic-test-only'},
      requestHandler: {handle: async request => {
        sent.push({headers: request.headers, body: request.body, path: request.path});
        return {response: {statusCode: 200, headers: {}, body: new Uint8Array()}};
      }},
    });
    const store = new AwsS3ObjectStore('synthetic-upload', {region: 'us-east-1', client, committedBucket: 'synthetic-journal'});
    const bytes = Buffer.from('{"record":"synthetic-preservation"}');
    try {
      await store.put('recovery/core/record.json', bytes, 'application/json');
      expect(await store.putIfAbsent('recovery/policy/record.json', bytes, 'application/json')).toEqual({created:true});
      expect(sent).toHaveLength(2);
      for (const request of sent) {
        expect(request.headers.host).toBe('synthetic-journal.s3.us-east-1.amazonaws.com');
        expect(request.headers['if-none-match']).toBe('*');
        expect(request.headers['x-amz-sdk-checksum-algorithm']).toBe('SHA256');
        expect(request.body).toEqual(bytes);
        expect(request.headers['x-amz-checksum-sha256']).toBe(createHash('sha256').update(bytes).digest('base64'));
      }
    } finally { client.destroy(); }
  });
  it("serves bytes when the content-addressed key matches the object digest", async () => {
    const bytes = Buffer.from("immutable-evidence");
    const key = `evidence/proof_1/evd_1/committed/sha256-${sha256Hex(bytes)}`;
    const store = new AwsS3ObjectStore("evidence-bucket", {
      region: "us-east-1",
      client: fakeS3Get(bytes),
    });

    const result = await store.get(key);
    expect(result?.body.equals(bytes)).toBe(true);
  });

  it("fails closed if storage returns different bytes for a committed digest key", async () => {
    const expected = Buffer.from("original-evidence");
    const replaced = Buffer.from("different-evidence");
    const key = `evidence/proof_1/evd_1/committed/sha256-${sha256Hex(expected)}`;
    const store = new AwsS3ObjectStore("evidence-bucket", {
      region: "us-east-1",
      client: fakeS3Get(replaced),
    });

    await expect(store.get(key)).rejects.toMatchObject({
      code: "EVIDENCE_OBJECT_INTEGRITY_FAILURE",
      httpStatus: 500,
    });
  });
});
