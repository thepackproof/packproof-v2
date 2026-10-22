import {Readable} from 'node:stream';
import type {Clock} from '../src/clock.js';
import type {EnvelopeS3Transport} from '../src/integrity/envelope-s3-store.js';
import {createRecipientS3Store} from '../src/export/recipient-s3-store.js';
import type {RecipientProtection} from '../src/export/recipient-preservation.js';
export function recipientStorageFixture(clock:Clock,policy:RecipientProtection) {
  const objects = new Map<string, { bytes: Buffer; version: string }>(), calls: Array<{ operation: string; input: any }> = [];
  let lostResponse = false, lostArtifactResponse = false, mode = 'COMPLIANCE', versionOverride: string | undefined, retention = policy.retainUntil;
  const transport: EnvelopeS3Transport = {
    head: async input => { calls.push({ operation: 'head', input }); const saved = objects.get(input.Key!); if (!saved) throw { $metadata: { httpStatusCode: 404 } }; return { VersionId: saved.version, $metadata: {} }; },
    get: async input => { calls.push({ operation: 'get', input }); const saved = objects.get(input.Key!); if (!saved || input.VersionId !== saved.version) throw Error('Exact version unavailable'); return { VersionId: versionOverride ?? saved.version, ContentLength: saved.bytes.length, Body: Readable.from([saved.bytes]) as any, $metadata: {} }; },
    put: async input => { calls.push({ operation: 'put', input }); if (objects.has(input.Key!)) throw { $metadata: { httpStatusCode: 412 } }; const saved = { bytes: Buffer.from(input.Body as Buffer), version: `version-${objects.size + 1}` }; objects.set(input.Key!, saved); if (lostResponse || (lostArtifactResponse && input.Key!.endsWith('/artifact.json'))) { lostResponse = false; lostArtifactResponse = false; throw Error('Response lost after actual fixture write'); } return { VersionId: saved.version, $metadata: {} }; },
    retention: async input => { calls.push({ operation: 'retention', input }); return { Retention: { Mode: mode as 'COMPLIANCE', RetainUntilDate: new Date(retention) }, $metadata: {} }; },
  };
  return { objects, calls, transport, store: createRecipientS3Store({ bucket: policy.bucket, expectedBucketOwner: '123456789012', clock, transport }),
    loseResponse: () => { lostResponse = true; }, loseArtifactResponse: () => { lostArtifactResponse = true; }, setMode: (value: string) => { mode = value; }, setRetention: (value: string) => { retention = value; }, setVersion: (value: string) => { versionOverride = value; } };
}
