import type { CommitExpectations } from "./commit-expectations.js";
import type { Readable } from "node:stream";

export interface UploadTarget {
  received?: boolean;
  method: "PUT";
  url: string;
  headers: Record<string, string>;
}
export interface StoredObject { body: Buffer; contentType: string; }
export interface ObjectReference { versionId?: string | null; }
export interface ObjectMetadata {
  byteSize: number;
  contentType: string;
  versionId?: string | null;
}
export interface ObjectStream extends ObjectMetadata { body: Readable; }
export interface ObjectDigest extends ObjectMetadata { sha256: string; }
export interface CommittedObject extends ObjectDigest { key: string; stagingVersionId?: string | null; }
export interface ObjectStore {
  /** Runtime adapters only issue database-governed gateway contracts. */
  readonly boundedUploadGateway?: boolean;
  readonly gatewayBaseUrl?: string;
  /** True only for a deployed, verified immutable journal policy, never inferred from S3 use. */
  readonly immutableRecoveryJournal?: boolean;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string, reference?: ObjectReference): Promise<StoredObject | null>;
  head?(key: string, reference?: ObjectReference): Promise<ObjectMetadata | null>;
  getStream?(key: string, input?: ObjectReference & { start?: number; end?: number }): Promise<ObjectStream | null>;
  putStream?(key: string, body: AsyncIterable<Uint8Array>, contentType: string, byteSize: number): Promise<{ versionId?: string | null }>;
  putIfAbsent?(key: string, body: Buffer, contentType: string): Promise<{ created: boolean }>;
  /** Cleanup is limited to staging; runtime adapters reject committed and journal deletion. */
  deleteStaging?(key: string, reference?: ObjectReference): Promise<void>;
  digest(key: string, reference?: ObjectReference): Promise<ObjectDigest | null>;
  commitUpload(key: string, expected?: CommitExpectations): Promise<CommittedObject | null>;
  createUploadTarget(input: { key: string; contentType: string }): Promise<UploadTarget>;
  putUpload(token: string, body: Buffer, contentType: string | undefined): Promise<{ key: string }>;
}
