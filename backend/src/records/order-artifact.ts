import type { AppDependencies } from '../app.js';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { sha256Hex } from '../hash.js';
import type { Installation } from './agent-enrollments.js';
import { readOrder, agentOrderFilter } from './order-feed.js';
import { projectOrders, refKey, type OrderRecord } from './order-projection.js';
import { installationOperation, activeScope } from './order-workspace.js';

type Projection = ReturnType<typeof projectOrders>['projections'][number];
interface Artifact {
  receiptId: string;
  originalSha256: string;
  sourceId: string;
  generation: number;
  fileName: string;
  mediaType: string;
  linkedByReceiptId: string;
}

const shaPattern = /^[a-f0-9]{64}$/;
const maxBytes = 3 * 1024 * 1024;
const notFound = () => new DomainError('ARTIFACT_NOT_FOUND', 'This artifact is unavailable for the selected order revision.', 404);
function artifactType(name: string, contentType: string, kind: string): string | null {
  if (kind === 'delivery' && /\.pdf$/i.test(name) && contentType === 'application/pdf') return 'application/pdf';
  if (kind === 'evidence' && /\.jpe?g$/i.test(name) && contentType === 'image/jpeg') return 'image/jpeg';
  if (kind === 'evidence' && /\.png$/i.test(name) && contentType === 'image/png') return 'image/png';
  if (kind === 'label' && /\.zpl$/i.test(name) && ['application/octet-stream', 'application/zpl', 'text/plain'].includes(contentType)) return 'application/zpl';
  return null;
}

// Each eligible sidecar explicitly binds a captured digest and source to a
// single order. A filename or a shared package association cannot confer access.
export async function attachMedia(db: Database, operation: string, proof: Projection) {
  const proposed = proof.events.flatMap(event => {
    const hash = event.fields.artifactSha256;
    const source = event.fields.artifactSourceId ?? event.sourceId;
    return typeof hash === 'string' && shaPattern.test(hash) && typeof source === 'string' &&
      ['label','evidence','delivery'].includes(event.kind) && event.associationScope === 'order' &&
      [event.entity,...event.references].some(ref => ['order','shipment','package','tracking'].includes(ref.type)) &&
      (event.kind !== 'delivery' || [event.entity,...event.references].some(ref => ['package','shipment'].includes(ref.type)))
      ? [{ hash, source, event }] : [];
  });
  const originalArtifacts: Artifact[] = [];
  if (proposed.length > 0) {
    const receipts = (await db.query<{id:string;source_id:string;generation:number;original_sha256:string;file_name:string;media_type:string}>(`
      SELECT DISTINCT ON (r.source_id,r.original_sha256,r.file_name,r.media_type)
        r.id,r.source_id,r.generation,r.original_sha256,r.file_name,r.media_type
      FROM record_order_receipts r WHERE r.operation_key=$1 AND r.original_sha256=ANY($2::text[])
        AND r.source_id=ANY($3::text[])
      ORDER BY r.source_id,r.original_sha256,r.file_name,r.media_type,r.received_at,r.id`,
      [operation,[...new Set(proposed.map(p=>p.hash))],[...new Set(proposed.map(p=>p.source))]])).rows;
    for (const {hash,source,event} of proposed) {
      const matches = receipts.filter(r => r.source_id === source && r.original_sha256 === hash && artifactType(r.file_name,r.media_type,event.kind));
      if (matches.length !== 1 || originalArtifacts.some(item => item.receiptId === matches[0].id)) continue;
      const r = matches[0];
      originalArtifacts.push({receiptId:r.id, originalSha256:hash, sourceId:source, generation:r.generation,
        fileName:r.file_name,mediaType:artifactType(r.file_name,r.media_type,event.kind)!,linkedByReceiptId:event.receiptId});
    }
  }
  return {...proof, originalArtifacts: originalArtifacts.sort((a,b)=>a.receiptId.localeCompare(b.receiptId))};
}

// A binary may arrive after its sidecar. Feed the already-indexed explicit
// relationships back into the normal revision reducer.
export async function affectedMediaReferences(db: Database, operation: string, sourceId: string, digest: string) {
  const rows=(await db.query<{record:OrderRecord}>(`SELECT record FROM record_order_events
    WHERE operation_key=$1 AND record->'fields' ? 'artifactSha256' AND record->'fields'->>'artifactSha256'=$2
    AND COALESCE(record->'fields'->>'artifactSourceId',source_id)=$3 LIMIT 513`,[operation,digest,sourceId])).rows;
  if(rows.length>512)throw new DomainError('SOURCE_LIMIT','This artifact has too many source references for automatic processing.',422);
  return [...new Set(rows.flatMap(row=>[row.record.entity,...row.record.references].map(refKey)))];
}

export function qualifiedArtifactBytes(bytes: Buffer, type: string) {
  if (bytes.length < 4 || bytes.length > maxBytes) return false;
  if (type === 'application/pdf') {
    return /^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(bytes.subarray(0,10).toString('latin1')) &&
      /%%EOF[\t\n\f\r ]*$/.test(bytes.toString('latin1'));
  }
  if (type === 'image/jpeg') return bytes[0]===255 && bytes[1]===216 && bytes[2]===255 &&
    bytes[bytes.length-2]===255 && bytes[bytes.length-1]===217;
  if (type === 'image/png') return bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) &&
    bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082','hex'));
  if (type !== 'application/zpl') return false;
  const label=bytes.toString('latin1').trim();
  return /^\^XA/i.test(label) && /\^XZ$/i.test(label) && (label.match(/\^XA/gi)?.length===1) && (label.match(/\^XZ/gi)?.length===1);
}

export async function readOrderArtifact(deps: Pick<AppDependencies,'objectStore'>, db: Database, installation: Installation,
  proofId: string, revision: string, receiptId: string) {
  const scope = await activeScope(db,installation);
  const filter = await agentOrderFilter(db,installation);
  const proof = await readOrder(db,filter,proofId,revision) as {originalArtifacts?: Artifact[]};
  const item=proof.originalArtifacts?.find(a=>a.receiptId===receiptId);
  if (!item || !shaPattern.test(item.originalSha256)) throw notFound();
  if (!scope.scope.sources.some(s=>s.id===item.sourceId && s.generation===item.generation))
    return {kind:'derived_excerpt',reason:'original_scope_unavailable',receiptId};
  if (item.mediaType === 'application/pdf') {
    // A dedicated POD sidecar identifies the applicable subject. An ambiguous,
    // revoked or reassigned cross-order attachment must stay out of the packet.
    const links = (await db.query<{source_id:string;generation:number;receipt_id:string;exclusive:boolean}>(`
      SELECT side.source_id,side.generation,e.receipt_id,
      COALESCE(l.proof_ids=ARRAY[$4]::text[] AND NOT l.unresolved,false) AS exclusive
      FROM record_order_events e JOIN record_order_receipts side ON side.id=e.receipt_id
      LEFT JOIN record_order_link_state l ON l.event_id=e.id AND l.operation_key=e.operation_key
      WHERE e.operation_key=$1 AND e.record->'fields'->>'artifactSha256'=$2
      AND COALESCE(e.record->'fields'->>'artifactSourceId',e.source_id)=$3 LIMIT 513`,
      [installationOperation(installation),item.originalSha256,item.sourceId,proofId])).rows;
    if (links.length > 512 || !links.some(link=>link.receipt_id===item.linkedByReceiptId) ||
        links.some(link=>!link.exclusive || !scope.scope.sources.some(s=>s.id===link.source_id && s.generation===link.generation)))
      return {kind:'derived_excerpt',reason:'original_scope_unavailable',receiptId};
  }
  const r=(await db.query<{object_key:string;object_version:string}>(`SELECT object_key,object_version FROM record_order_receipts
    WHERE id=$1 AND operation_key=$2 AND source_id=$3 AND generation=$4 AND original_sha256=$5`,
    [receiptId,installationOperation(installation),item.sourceId,item.generation,item.originalSha256])).rows[0];
  if (!r || r.object_key!==`evidence/${installation.organization_id}/order-originals/committed/sha256-${item.originalSha256}` || !r.object_version) throw notFound();
  const object=await deps.objectStore.get(r.object_key,{versionId:r.object_version});
  if (!object || sha256Hex(object.body)!==item.originalSha256)
    throw new DomainError('ORIGINAL_UNVERIFIED','The retained original could not be verified. Retry this revision.',503);
  if (!qualifiedArtifactBytes(object.body,item.mediaType)) return {kind:'derived_excerpt',receiptId,reason:'format_unqualified'};
  return {kind:'original',...item,bytesBase64:object.body.toString('base64')};
}
