import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { publicEvent, type EventRow } from './webhooks.js';

export interface StreamScope { tenantId: string; environment: 'sandbox' | 'live' }
interface Cursor extends StreamScope { v: 1; position: string; expiresAt: number; proofId: string | null }
export interface EventStreamConfig { signingKey: string; cursorLifetimeMs?: number }
const MAX_POSITION = 9223372036854775807n;
function key(config: EventStreamConfig) {
  const bytes = Buffer.from(config.signingKey, 'base64');
  if (bytes.length !== 32) throw new DomainError('EVENT_STREAM_UNAVAILABLE', 'Event cursor signing is not configured', 503);
  return bytes;
}
function sign(payload: string, config: EventStreamConfig) {
  return createHmac('sha256', key(config)).update(payload).digest();
}
function encode(cursor: Cursor, config: EventStreamConfig) {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${payload}.${sign(payload,config).toString('base64url')}`;
}
function invalid(): never { throw new DomainError('INVALID_CURSOR', 'Use a cursor from this event stream and query', 400); }
function decode(value: unknown, scope: StreamScope, proofId: string | null, clock: Clock, config: EventStreamConfig): Cursor {
  if (typeof value !== 'string' || value.length > 2048) return invalid();
  const parts=value.split('.');
  if(parts.length!==2 || !parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p))) return invalid();
  const signature=Buffer.from(parts[1],'base64url'), expected=sign(parts[0],config);
  if(signature.length!==expected.length || !timingSafeEqual(signature,expected)) return invalid();
  let c: Cursor;
  try { c=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8')); } catch { return invalid(); }
  if(!c || c.v!==1 || c.tenantId!==scope.tenantId || c.environment!==scope.environment || c.proofId!==proofId ||
    typeof c.position!=='string' || !/^\d{1,19}$/.test(c.position) || BigInt(c.position)>MAX_POSITION || !Number.isSafeInteger(c.expiresAt)) return invalid();
  if(c.expiresAt<=clock.now().getTime()) throw new DomainError('EVENT_CURSOR_EXPIRED', 'Resynchronize authorized Proof snapshots, then start a new event stream from the beginning and deduplicate event IDs', 410);
  return c;
}

/** Encode a committed boundary already read in the caller's database snapshot.
 * Internal callers choose an expiry within their documented retention window. */
export function createEventStreamCursor(scope: StreamScope, position: string, expiresAt: number,
  config: EventStreamConfig, proofId: string | null = null): string {
  if (!/^\d{1,19}$/.test(position) || BigInt(position) > MAX_POSITION || !Number.isSafeInteger(expiresAt)) return invalid();
  return encode({tenantId: scope.tenantId, environment: scope.environment, v: 1, position, expiresAt, proofId}, config);
}

/** Primary database only. Positions are decimal strings; never parse as Number. */
export async function listEventStream(db: Database, clock: Clock, scope: StreamScope, config: EventStreamConfig,
  input: {after?: unknown; limit?: unknown; proofId?: string}={}) {
  key(config);
  const proofId=input.proofId??null;
  if(input.limit!=null&&!(typeof input.limit==='number'||(typeof input.limit==='string'&&/^\d{1,3}$/.test(input.limit))))throw new DomainError('INVALID_LIMIT','limit must be an integer from 1 to 100',400);
  const limit=input.limit==null?100:Number(input.limit);
  if(!Number.isInteger(limit)||limit<1||limit>100) throw new DomainError('INVALID_LIMIT','limit must be an integer from 1 to 100',400);
  const position=input.after==null?'0':decode(input.after,scope,proofId,clock,config).position;
  // Capture a committed high-water mark before querying events. Counter and event
  // writes commit atomically and are immutable, so concurrent new writes cannot
  // introduce a missing position below this high-water mark.
  const head=(await db.query<{position:string;floor_position:string}>('SELECT position::text,floor_position::text FROM api_event_stream_heads WHERE tenant_id=$1',[scope.tenantId])).rows[0];
  const highWater=head?.position??'0',floor=head?.floor_position??'0';
  if(BigInt(position)<BigInt(floor)) throw new DomainError('EVENT_CURSOR_EXPIRED','History is no longer available; resynchronize authorized Proof snapshots before restarting the stream',410);
  if(BigInt(position)>BigInt(highWater)) return invalid();
  const found=await db.query<EventRow & {stream_position:string}>(`SELECT o.*,s.position::text AS stream_position
    FROM api_event_stream s JOIN proof_outbox o ON o.id=s.event_id
    WHERE s.tenant_id=$1 AND s.position>$2::bigint AND s.position<=$3::bigint
      AND ($4::text IS NULL OR o.proof_id=$4) ORDER BY s.position LIMIT $5`,[scope.tenantId,position,highWater,proofId,limit+1]);
  const rows=found.rows.slice(0,limit),hasMore=found.rows.length>limit;
  const next=hasMore?rows[rows.length-1].stream_position:highWater;
  const expiresAt=clock.now().getTime()+Math.min(config.cursorLifetimeMs??604800000,604800000);
  const cursor=(p:string)=>createEventStreamCursor(scope,p,expiresAt,config,proofId);
  return {schemaVersion:'packproof.event-stream/v1',environment:scope.environment,
    events:rows.map(r=>({...publicEvent(r,scope.tenantId),schemaVersion:'packproof.event/v1.1',environment:scope.environment,streamSequence:r.stream_position})),
    nextCursor:cursor(next),highWaterMark:cursor(highWater),hasMore,cursorExpiresAt:new Date(expiresAt).toISOString()};
}
