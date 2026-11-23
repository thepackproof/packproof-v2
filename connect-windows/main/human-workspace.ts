import { createHash } from 'node:crypto';
import { allowedDashboardRequest, type HumanDashboardIdentity } from './dashboard-grant';
import type { AttentionReport, OrderDetail, OrderSummary, WorkspaceSourceRecord } from '../ui/workspace-types';

export interface HumanWorkspaceScope { organizationId: string; environment: string; locationId: string | null }
export type HumanWorkspaceRead = 'snapshot' | 'workspaceSearchOrders' | 'workspaceOrderPage' | 'workspaceOrderDetail' | 'workspaceSourceRecord' | 'workspaceAttention';
export interface HumanWorkspaceSnapshot { orders: OrderSummary[]; nextBefore: number | null; totalOrders: number | null; updatedToday: number | null; updatedLast24Hours: number | null }
const identifier = /^[A-Za-z0-9_-]{1,160}$/;
const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('PackProof returned an unreadable workspace response.');
  return value as Record<string, unknown>;
};
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
const cursor = (value: unknown) => count(value) && Number(value) > 0 ? Number(value) : null;
const select = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key,value[key]]));
function smallFields(value: Record<string, unknown>, keys: string[]) {
  const result: Record<string,unknown> = {};
  for (const key of keys) {
    const field = value[key];
    if (typeof field === 'string') result[key] = field.slice(0,256);
    else if (typeof field === 'number' || typeof field === 'boolean') result[key] = field;
  }
  return result;
}
const eventFields = ['kind','sourceId','fileName','eventKey','eventId','version','receiptId','profileVersion',
  'sourceModifiedAt','originalSha256','locator','occurredAt','observedAt','associationScope','originalStatus','facilityId',
  'entity','references','lines','eventKind'];
const displayFields = ['customerName','CustomerName','customer','Customer','SoldToName','ShipToName',
  'purchaseOrder','purchaseOrderNumber','PurchaseOrderNumber','PONumber','skuDescription','description','ItemDescription',
  'plannedAt','scheduledAt','scheduledDeliveryAt','expectedDeliveryAt','status','deliveryStatus','orderReference',
  'facilityName','deliveryId','shipmentId','packageId','lineId','unit','sku','fulfillmentStatus','orderStatus',
  'plannedShipmentReference','plannedDeliveryDate','followUpStatus','followUpRequest','followUpOwner',
  'followUpRequestedAt','followUpEvidenceState','itemCounts','handoff','purchaseOrderReference'];
// Retain the existing native display projection. Raw fields and original bytes
// are retrieved only through the separately authorized source-record endpoint.
function displayEvent(event: Record<string, unknown>) {
  const result = select(event,eventFields);
  if (event.fields && typeof event.fields === 'object' && !Array.isArray(event.fields) && event.associationScope !== 'shared')
    result.fields = smallFields(event.fields as Record<string,unknown>,displayFields);
  return result;
}
const rows = (value: unknown) => {
  if (!Array.isArray(value)) throw Error('PackProof returned an unreadable order list.');
  return value.map(row);
};
function summary(value: unknown): OrderSummary {
  const item = row(value);
  if (typeof item.proofId !== 'string' || !identifier.test(item.proofId) || !count(item.revision) || typeof item.orderReference !== 'string')
    throw Error('PackProof returned an unreadable order reference.');
  const result = smallFields(item,['proofId','revision','orderReference','updatedAt','customerName','latestKind','issue','fulfillmentStatus','locationId']);
  if (Array.isArray(item.matchedSubjects)) result.matchedSubjects = item.matchedSubjects.slice(0,64).map(subject => smallFields(row(subject),['id','type','namespace']));
  return result as unknown as OrderSummary;
}

/** Main-process human-authorized reads for the local Evidence OS renderer.
 * The renderer can request only named operations, never a URL or token. */
export class HumanWorkspaceClient {
  constructor(private identity: HumanDashboardIdentity, private scope: HumanWorkspaceScope, private fetcher: typeof fetch = fetch) {
    if (!identity.userId || !identifier.test(scope.organizationId) || !['sandbox','live'].includes(scope.environment) ||
        !scope.locationId || !identifier.test(scope.locationId)) throw Error('Connect this computer to an authorized facility before opening orders.');
  }
  private async request(path: string, extra: Record<string,string> = {}): Promise<Record<string,unknown>> {
    const query = new URLSearchParams({...extra,organizationId:this.scope.organizationId,environment:this.scope.environment,locationId:this.scope.locationId!});
    const base = this.identity.apiBaseUrl.replace(/\/$/, '');
    const url = base + '/me/records/' + path + '?' + query;
    if (!allowedDashboardRequest(url,'GET',this.identity.apiBaseUrl,this.scope)) throw Error('This workspace operation is unavailable.');
    const token = await this.identity.token();
    if (!token) throw Error('Sign in again to read your facility records.');
    const response = await this.fetcher(url,{method:'GET',headers:{Accept:'application/json',Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(30_000)});
    if (!response.ok) {
      const data = await response.json().catch(() => null) as {error?:{message?:string;code?:string}} | null;
      const message = data?.error?.message;
      throw Object.assign(Error(typeof message === 'string' ? message : `Could not read your facility records (${response.status}).`),{status:response.status,code:data?.error?.code});
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error('PackProof returned an empty workspace response.');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 12 * 1024 * 1024) { await reader.cancel(); throw Error('This order response is too large to display. Open its online review.'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    return row(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }
  async read(method: HumanWorkspaceRead, args: unknown[] = []): Promise<HumanWorkspaceSnapshot | OrderSummary[] | OrderDetail | WorkspaceSourceRecord | AttentionReport | {orders:OrderSummary[];nextBefore:number|null}> {
    if (method === 'snapshot' || method === 'workspaceSearchOrders' || method === 'workspaceOrderPage') {
      const extra: Record<string,string> = {limit:'20'};
      if (method === 'snapshot') {
        const midnight = new Date(); midnight.setHours(0,0,0,0); extra.dayStart = midnight.toISOString();
      } else if (method === 'workspaceSearchOrders') {
        if (typeof args[0] !== 'string' || !args[0].trim() || args[0].length > 200 || /[\x00-\x1f\x7f]/.test(args[0])) throw Error('Enter an order reference of up to 200 characters.');
        extra.q = args[0]; extra.referenceType = 'any';
      } else {
        if (!cursor(args[0])) throw Error('Refresh the order list.');
        extra.before = String(args[0]);
      }
      const result = await this.request('order-proofs',extra);
      const orders = rows(result.orders).slice(0,20).map(summary);
      if (method === 'workspaceSearchOrders') return orders;
      const page = {orders,nextBefore:cursor(result.nextBefore)};
      return method === 'snapshot' ? {...page,totalOrders:count(result.totalOrders),updatedToday:count(result.updatedToday),updatedLast24Hours:count(result.updatedLast24Hours)} : page;
    }
    if (method === 'workspaceAttention') {
      const extra: Record<string,string> = {includeOrderIssues:'1'};
      if (args[0] !== undefined) { if (!cursor(args[0])) throw Error('Refresh the attention list.'); extra.before = String(args[0]); }
      const result = await this.request('order-attention',extra);
      const items = rows(result.items);
      return {items:items.slice(0,20).map(item => smallFields(item,['proofId','revision','orderReference','sourceId','fileName','locator','kind','reason'])),
        hasMore:items.length > 20 || result.hasMore === true,
        ...(count(result.orderIssueCount) !== null ? {orderIssueCount:Number(result.orderIssueCount)} : {}),
        orderIssues:Array.isArray(result.orderIssues) ? result.orderIssues.slice(0,20).map(summary) : [],nextIssuesBefore:cursor(result.nextIssuesBefore)};
    }
    const [proofId,revision,eventKey] = args;
    if (typeof proofId !== 'string' || !identifier.test(proofId) || !count(revision)) throw Error('Choose an order from the current list.');
    const path = 'order-proofs/'+proofId+'/revisions/'+revision;
    if (method === 'workspaceOrderDetail') {
      const proof = await this.request(path);
      if (proof.proofId !== proofId || proof.revision !== revision) throw Error('This order revision changed. Open it again from your workspace.');
      const result = summary(proof);
      const lines = rows(proof.lines), events = rows(proof.events), evidence = rows(proof.evidence);
      const packages = new Set<string>();
      for (const event of events) for (const ref of [event.entity,...(Array.isArray(event.references) ? event.references : [])]) {
        if (ref && typeof ref === 'object' && 'type' in ref && ref.type === 'package' && 'id' in ref && typeof ref.id === 'string') packages.add(ref.id);
      }
      return {...result,...select(proof,['integrity','customerName','purchaseOrder','facilities','conflicts','originalArtifacts']),
        lines,events:events.map(displayEvent),evidence:evidence.map(displayEvent),packages:[...packages].map(packageId => ({packageId})),totals:{lines:lines.length,events:events.length,evidence:evidence.length}} as OrderDetail;
    }
    if (method !== 'workspaceSourceRecord' || typeof eventKey !== 'string' || !identifier.test(eventKey)) throw Error('Choose a source record in this Proof.');
    const source = await this.request(path+'/sources/'+eventKey);
    if (!['original','derived_excerpt'].includes(String(source.kind)) || source.eventKey !== eventKey) throw Error('PackProof could not verify this source record.');
    const result = select(source,['kind','eventKey','receiptId','originalSha256','fileName','fields','fieldLineage','locator','sourceId','observedAt','occurredAt','version','profileVersion','lines','eventKind','originalText','mediaType','reason']);
    if (source.artifactReceiptId !== undefined) {
      if (typeof source.artifactReceiptId !== 'string' || !identifier.test(source.artifactReceiptId)) throw Error('PackProof could not verify the original artifact.');
      const artifact = await this.request(path+'/artifacts/'+source.artifactReceiptId);
      if (artifact.receiptId !== source.artifactReceiptId) throw Error('PackProof could not verify the original artifact.');
      if (artifact.kind === 'original') {
        if (!['image/jpeg','image/png','application/zpl'].includes(String(artifact.mediaType)) || typeof artifact.bytesBase64 !== 'string') throw Error('This original requires online review.');
        const bytes = Buffer.from(artifact.bytesBase64,'base64');
        if (bytes.length > 3*1024*1024 || createHash('sha256').update(bytes).digest('hex') !== artifact.originalSha256) throw Error('The original artifact did not pass its integrity check.');
        result.artifact = select(artifact,['receiptId','fileName','originalSha256','mediaType','bytesBase64']);
      }
    }
    return result as unknown as WorkspaceSourceRecord;
  }
}
