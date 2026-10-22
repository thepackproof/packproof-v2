/** Test double for domain/worker state transitions; not storage-lock evidence. */
import { Readable } from 'node:stream';
import { MemoryObjectStore } from './memory-object-store.js';
import { assertCommitExpectations, type CommitExpectations } from '../src/s3/commit-expectations.js';
import type { ObjectReference } from '../src/s3/object-store.js';
import { sha256Hex } from '../src/hash.js';

export class VersionedMemoryObjectStore extends MemoryObjectStore {
  async head(key: string, reference: ObjectReference = {}) {
    const saved = await super.get(key); if (!saved) return null;
    const versionId = key.includes('/committed/') ? `test-sha256:${sha256Hex(saved.body)}` : null;
    if (reference.versionId && reference.versionId !== versionId) throw Error('Exact test version unavailable');
    return { contentType: saved.contentType, byteSize: saved.body.length, versionId };
  }
  async get(key: string, reference: ObjectReference = {}) { await this.head(key, reference); return super.get(key); }
  async getStream(key: string, reference: ObjectReference = {}) {
    const saved = await this.get(key, reference), metadata = await this.head(key, reference);
    return saved && metadata ? { ...metadata, body: Readable.from([saved.body]) } : null;
  }
  async commitUpload(key: string, expected: CommitExpectations = {}) {
    const saved = await this.get(key); if (!saved) return null;
    assertCommitExpectations({ sha256: sha256Hex(saved.body), byteSize: saved.body.length, contentType: saved.contentType }, expected);
    const result = await super.commitUpload(key);
    return result ? { ...result, versionId: `test-sha256:${result.sha256}` } : null;
  }
}
