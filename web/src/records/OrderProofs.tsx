import { useEffect, useState } from 'react';
import type { PackProofApi } from '../api/client';
import { displayState, recordsPath } from './model';
import type { RecordOrganization } from './types';
import { workflowError } from './workflow';
import { RemoveOrderLink } from './OrderReferenceReview';
import { OrderEvidence, OrderPacketDownload, revisionPath } from './OrderEvidence';
import { OrderCaseReview } from './OrderCaseReview';
import { OrderRevisionChanges } from './OrderRevisionChanges';

interface Subject { type: string; id: string; namespace: string; sourceId?:string }
interface OrderSummary { proofId: string; revision: number; orderReference: string; updatedAt: string; locationId?:string; matchedSubjects?:Subject[] }
interface OrderLine { lineId: string; sku?: string; orderedQuantity?: string; pickedQuantity?: string; packedQuantity?: string; shippedQuantity?: string; orderedShippedDiscrepancy?: string; loadedAcknowledgedDiscrepancy?: string }
interface OrderEvent { eventKey?: string; kind: string; occurredAt?: string; observedAt?:string; firstSeenAt?:string; sourceId: string; fileName?: string; locator?: string; entity?: Subject; references?:Subject[]; fields: Record<string, unknown> }
interface OrderDetail extends OrderSummary {
  deliveryCoverage?:'configured'|'outside_approved_sources'|'unreported';
  lines: OrderLine[];
  events: OrderEvent[];
  evidence: { eventKey?:string; fileName?: string; kind?: string; locator?: string; sourceId?: string }[];
  originalArtifacts?: {receiptId:string;fileName:string}[];
  cartons?: {id:string;namespace:string;lastEventKind:string;lastEventKey:string;occurredAt?:string;observedAt?:string;deliveryStatus:string}[];
  conflicts?: string[];
}
interface Snapshot { orders: OrderSummary[]; cursor: number; nextBefore?:number|null }
interface Changes { changes: { sequence: number; proofId: string; revision: number }[]; nextCursor: number; hasMore: boolean }

function useOrderView(api: PackProofApi, scope: string, listQuery: string, id: string | null, pinned: string | null, reload: number) {
  const [view, setView] = useState<{ rows: OrderSummary[]; nextBefore?:number|null; detail: OrderDetail | null } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true, cursor: number | null = null, snapshotAt = 0, timeout: ReturnType<typeof setTimeout>;
    let retryMs = 1500;
    setView(null);
    setError('');
    async function sync() {
      try {
        let refresh = cursor === null || Date.now() - snapshotAt >= 30000;
        if (!refresh) {
          let more = true;
          while (more) {
            const changes: Changes = await api.recordsRequest('/order-changes?' + scope + '&limit=50&after=' + cursor);
            if (!active) return;
            if (changes.nextCursor < cursor! || (changes.hasMore && changes.nextCursor === cursor)) {refresh = true; break;}
            refresh ||= changes.changes.length > 0;
            cursor = changes.nextCursor;
            more = changes.hasMore;
          }
        }
        if (refresh) {
          const query = new URLSearchParams(listQuery);
          if (pinned !== null && (!/^[1-9]\d*$/.test(pinned) || Number(pinned)>2147483647)) throw Error('Choose a valid saved revision.');
          // The snapshot and watermark come from the same read. Detail is fetched
          // afterwards, so changes observed during that read remain replayable.
          const snapshot = await api.recordsRequest<Snapshot>('/order-proofs?' + query);
          if (!active) return;
          const detailPath = id && (pinned ? revisionPath(id,Number(pinned)) : '/order-proofs/' + encodeURIComponent(id));
          const detail = detailPath ? await api.recordsRequest<OrderDetail>(detailPath + '?' + scope) : null;
          if (!active) return;
          if (detail && (detail.proofId !== id || (pinned && detail.revision !== Number(pinned)))) throw new Error('The returned order changed. Reopen it from Orders.');
          setView({ rows: snapshot.orders, nextBefore: snapshot.nextBefore, detail });
          cursor = snapshot.cursor;
          snapshotAt = Date.now();
        }
        setError('');
        retryMs = 1500;
      } catch (caught) {
        if (!active) return;
        setError(workflowError(caught));
        setView(null);
        cursor = null;
        retryMs = Math.min(30000, retryMs * 2);
      }
      if (active) timeout = setTimeout(() => void sync(), retryMs);
    }
    void sync();
    return () => { active = false; clearTimeout(timeout); };
  }, [api, scope, listQuery, id, pinned, reload]);
  return { view, error };
}

const referenceTypes = {any:'Any reference',order:'Order',pick:'Pick ticket',package:'Carton',shipment:'Shipment',tracking:'Tracking number'};
type RefType = keyof typeof referenceTypes;
const stageNames: Record<string,string> = {order:'Order received',picking:'Picking recorded',packing:'Packed',label:'Label printed',handoff:'Carrier handoff',delivery:'Delivery recorded',return:'Return recorded',correction:'Correction recorded'};
const stage = (kind:string) => stageNames[kind] || displayState(kind);
function clock(value?:string) { return value ? new Date(value).toLocaleString() : 'Time not reported'; }

function OrderContents({ order, api, scope, canManage, canAct, refresh, route }: { order: OrderDetail; api: PackProofApi; scope: string; canManage: boolean; canAct:boolean; refresh: () => void; route: URLSearchParams }) {
  const subject = route.get('subject'), namespace = route.get('namespace'), type = route.get('subjectType');
  const matches = (ref: Subject) => ref.id === subject && (!type || ref.type === type) && (!namespace || ref.namespace === namespace);
  const filtered = subject ? order.events.filter(e => (e.entity && matches(e.entity)) || e.references?.some(matches)
    || (type === 'order' && e.kind === 'order' && e.entity?.namespace === namespace && [e.fields.orderReference,e.fields.sourceOrderName].includes(subject))) : order.events;
  const cartons = order.cartons?.filter(c => !subject || matches({...c,type:'package'})) ?? [];
  const props = {api,scope,proofId:order.proofId,revision:order.revision};
  const detailLink = (updates:Record<string,string|null>) => recordsPath('order-proofs',route,updates,order.proofId);
  return <>
    <section className="records-panel"><h2>{subject ? (referenceTypes[type as RefType] || 'Reference') + ' ' + subject : 'Cartons'}</h2>
      {subject && <p><a href={detailLink({subject:null,namespace:null,subjectType:null})}>See the whole order</a></p>}
      {cartons.map(carton => <article key={carton.namespace + '/' + carton.id}>
        <h3>{carton.id}</h3><p>{stage(carton.lastEventKind)} · {clock(carton.occurredAt)}</p>
        <p>{carton.deliveryStatus === 'delivered' ? 'Delivery supported by evidence' : order.deliveryCoverage === 'outside_approved_sources' ? 'Delivery is outside the approved sources for this revision.' : 'Awaiting delivery evidence'}</p>
        {carton.lastEventKey && <a href={'#event-' + encodeURIComponent(carton.lastEventKey)}>See supporting event</a>}
      </article>)}
      {!cartons.length && <p>{subject ? (filtered.length ? 'Matching events are shown below.' : 'No matching subject in this revision.') : 'No carton summary recorded in this revision.'}</p>}
    </section>
    {!!order.conflicts?.length && <div className="records-notice warning"><div><strong>Source reports disagree</strong><ul>{order.conflicts.map(item => <li key={item}>{item}</li>)}</ul></div></div>}
    <section className="records-panel"><h2>Items</h2>
      {!order.lines.length ? <p>Waiting for line items.</p> : <ul>{order.lines.map(line => <li key={line.lineId}>
        <strong>{line.sku ?? 'Item'}</strong> · Line {line.lineId}
        <dl className="records-facts">
          {([['Ordered', line.orderedQuantity], ['Picked', line.pickedQuantity], ['Packed', line.packedQuantity], ['Shipped', line.shippedQuantity]] as const)
            .filter(([, quantity]) => quantity != null).map(([label, quantity]) => <div key={label}><dt>{label}</dt><dd>{quantity}</dd></div>)}
        </dl>
        {line.orderedShippedDiscrepancy && <p>{line.orderedShippedDiscrepancy}</p>}
      </li>)}</ul>}
    </section>
    <section className="records-panel"><h2>Order timeline</h2>
      {!filtered.length ? <p>Waiting for source reports.</p> : <ol>{filtered.map((event, index) => <li key={event.eventKey || index} id={'event-' + encodeURIComponent(event.eventKey || String(index))}>
        <strong>{stage(event.kind)}</strong><p>Event time · {clock(event.occurredAt)}</p>
        <p>Received by PackProof · {clock(event.observedAt)}</p>
        {event.firstSeenAt && <p>First seen by collector · {clock(event.firstSeenAt)}</p>}
        {event.fileName && <p>{event.fileName}</p>}
        {event.entity && <p>{displayState(event.entity.type)} {event.entity.id}</p>}
        <details><summary>Source details</summary><p>{event.sourceId} {event.locator}</p>
          <dl className="records-facts">{Object.entries(event.fields ?? {}).filter(([, value]) => typeof value === 'string' || typeof value === 'number')
            .map(([field, value]) => <div key={field}><dt>{displayState(field.replace(/([a-z])([A-Z])/g, '$1 $2'))}</dt><dd>{String(value)}</dd></div>)}</dl>
        </details>
        {event.eventKey && <OrderEvidence {...props} id={event.eventKey}/>}
        {canManage && !route.has('revision') && event.eventKey && event.kind !== 'order' && <RemoveOrderLink api={api} scope={scope} proofId={order.proofId} revision={order.revision} eventKey={event.eventKey} onSaved={refresh}/>}
      </li>)}</ol>}
    </section>
    <section className="records-panel"><h2>Evidence</h2>
      {order.evidence.length ? <ul>{order.evidence.map((item, index) => <li key={index}>{item.fileName || 'Source report'}{item.kind === 'derived_excerpt' && ' · Excerpt'}{item.locator && <small> · {item.locator}</small>}</li>)}</ul> : <p>No evidence files in this revision.</p>}
      {order.originalArtifacts?.map(a => <article key={a.receiptId}><strong>{a.fileName || 'Linked original'}</strong><OrderEvidence {...props} id={a.receiptId} artifact/></article>)}
      <details><summary>Revision history</summary><p>Revision {order.revision} · {order.proofId}</p>
        {order.revision > 1 && <p><a href={detailLink({revision:String(order.revision-1)})}>Previous revision</a></p>}
        <a href={detailLink({revision:route.has('revision') ? null : String(order.revision)})}>{route.has('revision') ? 'View latest revision' : 'Open this saved revision'}</a>
        <OrderRevisionChanges api={api} scope={scope} current={order}/>
      </details>
      <OrderPacketDownload {...props}/>
    </section>
    {!route.has('revision') && <OrderCaseReview {...props} canAct={canAct} gaps={[
      {key:'order',label:'Order discrepancy',open:!!order.conflicts?.length || order.lines.some(l=>!!l.orderedShippedDiscrepancy || !!l.loadedAcknowledgedDiscrepancy)},
      ...(order.cartons || []).map(c=>({key:'carton:'+c.namespace+':'+c.id,label:'Carton '+c.id,open:c.deliveryStatus==='awaiting_evidence'}))
    ]}/>}
  </>;
}

export function OrderProofs({ api, organization, locationId, id, revision, routeParams }: {
  api: PackProofApi; organization: RecordOrganization; locationId: string | null; id: string | null; revision: number; routeParams?:URLSearchParams;
}) {
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [retry, setRetry] = useState(0);
  const [type,setType] = useState<RefType>('any'), [searchType,setSearchType] = useState<RefType>('any');
  const [before,setBefore] = useState<number|null>(null);
  const params = new URLSearchParams({ organizationId: organization.id, environment: organization.environment });
  if (locationId) params.set('locationId', locationId);
  const route = new URLSearchParams(params);
  for (const key of ['revision','subject','namespace','subjectType','desktopUser']) {
    const value=routeParams?.get(key); if (value !== undefined && value !== null) route.set(key,value);
  }
  const list = new URLSearchParams(params);
  list.set('limit','20');
  if (search) { list.set('q',search); list.set('referenceType',searchType); }
  if (before) list.set('before',String(before));
  const { view, error } = useOrderView(api, params.toString(), list.toString(), id, route.get('revision'), retry + revision);
  const allOrders = recordsPath('order-proofs',route,{revision:null,subject:null,namespace:null,subjectType:null});
  return <>
    <header className="records-page-heading"><div>{id && <a href={allOrders}>All orders</a>}
      <h1>{view?.detail?.orderReference || (id ? 'Order' : 'Orders')}</h1></div></header>
    {!id && <form role="search" className="records-search" onSubmit={e => { e.preventDefault(); setBefore(null); setSearchType(type); setSearch(query.trim()); }}>
      <label>Reference type<select value={type} onChange={e => setType(e.target.value as RefType)}>{Object.entries(referenceTypes).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label htmlFor="order-ref">Exact reference</label><input id="order-ref" value={query} maxLength={200} onChange={e => setQuery(e.target.value)}/>
      <button className="records-button" type="submit">Find order</button>
      {search && <button type="button" className="records-button secondary" onClick={() => { setQuery(''); setSearch(''); setBefore(null); }}>Clear</button>}
    </form>}
    {error ? <div role="alert"><p>{error}</p><button className="records-button secondary" onClick={() => setRetry(n => n + 1)}>Try again</button></div>
      : !view ? <p role="status">Checking order records…</p>
      : view.detail ? <OrderContents key={view.detail.proofId + '/' + view.detail.revision} order={view.detail} api={api} scope={params.toString()} route={route} canAct={organization.role!=='REVIEWER'} canManage={['ADMIN','OWNER'].includes(organization.role)} refresh={() => setRetry(n => n+1)}/> : <section className="records-panel"><h2>{search ? 'Search results' : 'Recently updated orders'}</h2>
        {!view.rows.length ? <p>{search ? 'No order matches this number.' : 'Waiting for the first order.'}</p> :
          <ul>{view.rows.map(row => <li key={row.proofId}><a href={recordsPath('order-proofs', route, {}, row.proofId)}>{row.orderReference}</a>
            {' · Revision ' + row.revision + ' · ' + clock(row.updatedAt)}
            {row.locationId && <p>{organization.locations.find(l => l.id === row.locationId)?.name || row.locationId}</p>}
            {row.matchedSubjects?.map(ref => <p key={JSON.stringify(ref)}><a href={recordsPath('order-proofs', route, {subject:ref.id,subjectType:ref.type,namespace:ref.namespace}, row.proofId)}>
              {referenceTypes[ref.type as RefType] || displayState(ref.type)} {ref.id}</a> · {ref.namespace}{ref.sourceId && ' · ' + ref.sourceId}</p>)}
          </li>)}</ul>}
          {view.nextBefore && <button type="button" className="records-button secondary" onClick={() => setBefore(view.nextBefore!)}>Next page</button>}
          {before && <button type="button" className="records-text-button" onClick={() => setBefore(null)}>Back to first page</button>}
      </section>}
  </>;
}
