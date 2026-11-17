import { useEffect, useState } from 'react';
import type { PackProofApi } from '../api/client';
import { displayState, recordsPath } from './model';
import type { RecordOrganization } from './types';
import { workflowError } from './workflow';
import { RemoveOrderLink } from './OrderReferenceReview';

interface OrderSummary { proofId: string; revision: number; orderReference: string; updatedAt: string }
interface OrderLine { lineId: string; sku?: string; orderedQuantity?: string; pickedQuantity?: string; packedQuantity?: string; shippedQuantity?: string }
interface OrderEvent { eventKey?: string; kind: string; occurredAt?: string; sourceId: string; fileName?: string; locator?: string; entity?: {type:string;id:string}; fields: Record<string, unknown> }
interface OrderDetail extends OrderSummary {
  lines: OrderLine[];
  events: OrderEvent[];
  evidence: { fileName?: string; kind?: string; locator?: string; sourceId?: string }[];
  conflicts?: string[];
}
interface Snapshot { orders: OrderSummary[]; cursor: number }
interface Changes { changes: { sequence: number; proofId: string; revision: number }[]; nextCursor: number; hasMore: boolean }

function useOrderView(api: PackProofApi, scope: string, search: string, id: string | null, reload: number) {
  const [view, setView] = useState<{ rows: OrderSummary[]; detail: OrderDetail | null } | null>(null);
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
          const changes = await api.recordsRequest<Changes>('/order-changes?' + scope + '&limit=50&after=' + cursor);
          if (!active) return;
          refresh = changes.hasMore || changes.changes.length > 0 || changes.nextCursor < cursor!;
          if (!refresh) cursor = changes.nextCursor;
        }
        if (refresh) {
          const query = new URLSearchParams(scope);
          query.set('limit', '20');
          if (search) query.set('q', search);
          // The snapshot and watermark come from the same read. Detail is fetched
          // afterwards, so changes observed during that read remain replayable.
          const snapshot = await api.recordsRequest<Snapshot>('/order-proofs?' + query);
          if (!active) return;
          const detail = id ? await api.recordsRequest<OrderDetail>('/order-proofs/' + encodeURIComponent(id) + '?' + scope) : null;
          if (!active) return;
          if (detail && detail.proofId !== id) throw new Error('The returned order changed. Reopen it from Orders.');
          setView({ rows: snapshot.orders, detail });
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
  }, [api, scope, search, id, reload]);
  return { view, error };
}

function OrderContents({ order, api, scope, canManage, refresh }: { order: OrderDetail; api: PackProofApi; scope: string; canManage: boolean; refresh: () => void }) {
  return <>
    {!!order.conflicts?.length && <div className="records-notice warning"><div><strong>Source reports disagree</strong><ul>{order.conflicts.map(item => <li key={item}>{item}</li>)}</ul></div></div>}
    <section className="records-panel"><h2>Items</h2>
      {!order.lines.length ? <p>Waiting for line items.</p> : <ul>{order.lines.map(line => <li key={line.lineId}>
        <strong>{line.sku ?? 'Item'}</strong> · Line {line.lineId}
        <dl className="records-facts">
          {([['Ordered', line.orderedQuantity], ['Picked', line.pickedQuantity], ['Packed', line.packedQuantity], ['Shipped', line.shippedQuantity]] as const)
            .filter(([, quantity]) => quantity != null).map(([label, quantity]) => <div key={label}><dt>{label}</dt><dd>{quantity}</dd></div>)}
        </dl>
      </li>)}</ul>}
    </section>
    <section className="records-panel"><h2>Order timeline</h2>
      {!order.events.length ? <p>Waiting for source reports.</p> : <ol>{order.events.map((event, index) => <li key={index}>
        <strong>{displayState(event.kind)}</strong> · {event.occurredAt ? new Date(event.occurredAt).toLocaleString() : 'Time not reported'}
        {event.fileName && <p>{event.fileName}</p>}
        {event.entity && <p>{displayState(event.entity.type)} {event.entity.id}</p>}
        <details><summary>Source details</summary><p>{event.sourceId} {event.locator}</p>
          <dl className="records-facts">{Object.entries(event.fields ?? {}).filter(([, value]) => typeof value === 'string' || typeof value === 'number')
            .map(([field, value]) => <div key={field}><dt>{displayState(field.replace(/([a-z])([A-Z])/g, '$1 $2'))}</dt><dd>{String(value)}</dd></div>)}</dl>
        </details>
        {canManage && event.eventKey && event.kind !== 'order' && <RemoveOrderLink api={api} scope={scope} proofId={order.proofId} revision={order.revision} eventKey={event.eventKey} onSaved={refresh}/>}
      </li>)}</ol>}
    </section>
    <section className="records-panel"><h2>Evidence</h2>
      {order.evidence.length ? <ul>{order.evidence.map((item, index) => <li key={index}>{item.fileName || 'Source report'}{item.kind === 'derived_excerpt' && ' · Excerpt'}{item.locator && <small> · {item.locator}</small>}</li>)}</ul> : <p>No evidence files in this revision.</p>}
      <details><summary>Revision details</summary><p>Revision {order.revision} · {order.proofId}</p></details>
    </section>
  </>;
}

export function OrderProofs({ api, organization, locationId, id, revision }: {
  api: PackProofApi; organization: RecordOrganization; locationId: string | null; id: string | null; revision: number;
}) {
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [retry, setRetry] = useState(0);
  const params = new URLSearchParams({ organizationId: organization.id, environment: organization.environment });
  if (locationId) params.set('locationId', locationId);
  const { view, error } = useOrderView(api, params.toString(), search, id, retry + revision);
  return <>
    <header className="records-page-heading"><div>{id && <a href={recordsPath('order-proofs', params)}>All orders</a>}
      <h1>{view?.detail?.orderReference || (id ? 'Order' : 'Orders')}</h1></div></header>
    {!id && <form role="search" className="records-search" onSubmit={e => { e.preventDefault(); setSearch(query.trim()); }}>
      <label htmlFor="order-ref">Order number</label><input id="order-ref" value={query} maxLength={200} onChange={e => setQuery(e.target.value)}/>
      <button className="records-button" type="submit">Find order</button>
      {search && <button type="button" className="records-button secondary" onClick={() => { setQuery(''); setSearch(''); }}>Clear</button>}
    </form>}
    {error ? <div role="alert"><p>{error}</p><button className="records-button secondary" onClick={() => setRetry(n => n + 1)}>Try again</button></div>
      : !view ? <p role="status">Checking order records…</p>
      : view.detail ? <OrderContents order={view.detail} api={api} scope={params.toString()} canManage={['ADMIN','OWNER'].includes(organization.role)} refresh={() => setRetry(n => n+1)}/> : <section className="records-panel"><h2>{search ? 'Search results' : 'Recently updated orders'}</h2>
        {!view.rows.length ? <p>{search ? 'No order matches this number.' : 'Waiting for the first order.'}</p> :
          <ul>{view.rows.map(row => <li key={row.proofId}><a href={recordsPath('order-proofs', params, {}, row.proofId)}>{row.orderReference}</a> · {new Date(row.updatedAt).toLocaleString()}</li>)}</ul>}
      </section>}
  </>;
}
