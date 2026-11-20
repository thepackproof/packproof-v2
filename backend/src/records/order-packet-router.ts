import express from 'express';
import type { AppDependencies } from '../app.js';
import type { Database } from '../db/database.js';
import { newId } from '../ids.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { DomainError } from '../domain/errors.js';
import { auditOrganization } from '../platform/organizations.js';
import { requireRecordWorkspace, type RecordWorkspace } from './access.js';
import { humanOrderFilter, readOrder } from './order-feed.js';
import { humanOrderOriginal } from './order-human-original.js';

type Item = { kind: 'source' | 'artifact'; id: string };
type ManifestItem = Item & { disposition: 'original' | 'excerpt' | 'omitted'; reason?: string };
function checkSize(bytes:number) {
  if (bytes > 32 * 1024 * 1024) throw new DomainError('PACKET_SIZE_LIMIT', 'This revision exceeds the single-download size limit.', 413);
}
type PublishedOrder = {
  proofId: string; revision: number;
  evidence: {eventKey: string}[];
  originalArtifacts?: {receiptId: string}[];
};

// Assemble under the same access checks used by the interactive detail and original views.
// A denied item becomes a declared omission. Storage or integrity failures abort publication.
export async function buildOrderPacket(deps: AppDependencies, tx: Database, w: RecordWorkspace,
  proofId: string, revision: string, locationId: unknown) {
  const pinned = await readOrder(tx, await humanOrderFilter(tx, w, locationId), proofId, revision) as PublishedOrder;
  const { originalArtifacts = [], ...projection } = pinned;
  const items: Item[] = [
    ...new Set(projection.evidence.map(event => event.eventKey)),
  ].map(id => ({kind: 'source', id}));
  for (const id of new Set(originalArtifacts.map(item => item.receiptId))) items.push({kind: 'artifact', id});
  if (items.length > 512) throw new DomainError('PACKET_SIZE_LIMIT', 'This revision exceeds the single-download evidence limit.', 413);
  const manifest: ManifestItem[] = [];
  const contents: (Item & {record: Record<string,unknown>})[] = [];
  let size = Buffer.byteLength(JSON.stringify(projection));
  checkSize(size);
  for (const item of items) {
    try {
      const record = await humanOrderOriginal(deps, tx, w, proofId, revision, item.kind, item.id, locationId) as Record<string,unknown>;
      if (record.kind !== 'original' && record.kind !== 'derived_excerpt')
        throw new DomainError('ORIGINAL_UNVERIFIED', 'This revision contains an unverified source.', 503);
      size += Buffer.byteLength(JSON.stringify(record));
      checkSize(size);
      const reason = typeof record.reason === 'string' ? record.reason : undefined;
      manifest.push({...item, disposition: record.kind === 'original' ? 'original' : 'excerpt', ...(reason ? {reason} : {})});
      contents.push({...item, record});
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'ORIGINAL_ACCESS_DENIED') throw error;
      manifest.push({...item, disposition: 'omitted', reason: 'original_access_denied'});
    }
  }
  const packet = {schema: 'packproof.order-packet/v1', exportId: newId('order_export'), proofId, revision: pinned.revision,
    exportedAt: deps.clock.now().toISOString(), destination: 'user_download', projection, manifest, contents};
  checkSize(Buffer.byteLength(JSON.stringify(packet)));
  await tx.query(`INSERT INTO record_order_packet_exports
    (id,proof_id,revision,membership_id,exported_at,destination,manifest,packet_sha256)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [packet.exportId, proofId, packet.revision, w.membershipId, packet.exportedAt, packet.destination,
      JSON.stringify(manifest), sha256Hex(canonicalize(packet))]);
  await auditOrganization(tx, deps.clock, {userId:w.userId, merchantId:w.organizationId, requestId:packet.exportId,
    operation:'ORDER_REVISION_EXPORTED', resourceId:proofId});
  return packet;
}
export function orderPacketRouter(deps: AppDependencies) {
  const router = express.Router();
  router.post('/order-proofs/:proofId/revisions/:revision/packet', async (req, res, next) => {
    try {
      const actor = await deps.auth.authenticate(req.headers);
      const result = await deps.db.transaction(async tx => {
        const workspace = await requireRecordWorkspace(tx, actor.userId, req.query.organizationId, req.query.environment);
        return buildOrderPacket(deps, tx, workspace, req.params.proofId, req.params.revision, req.query.locationId);
      });
      res.set('Cache-Control','private, no-store').json(result);
    } catch (error) { next(error); }
  });
  return router;
}
