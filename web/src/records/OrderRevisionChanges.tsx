import { displayState } from './model';

export interface OrderChange {
  kind:string;
  sourceId:string;
  subject?:{id:string;type:string};
  eventKey?:string;
  previousEventKey?:string;
  receiptId?:string;
  profileVersion?:string;
  locator?:string;
  observedAt?:string;
  fields?:{scope:string;field:string;previous?:unknown;current?:unknown}[];
}

export function OrderRevisionChanges({revision,changes}: {revision:number;changes?:OrderChange[]}) {
  if (revision<=1) return <p>First recorded revision.</p>;
  if (!changes) return <p>Open the previous revision to compare its saved evidence.</p>;
  return <details><summary>What changed since revision {revision-1}?</summary>
    <ul>{changes.map((item,i)=><li key={JSON.stringify([item.kind,item.eventKey,item.previousEventKey,item.receiptId,i])}>
      <strong>{displayState(item.kind)}</strong>{item.subject && ' · ' + displayState(item.subject.type) + ' ' + item.subject.id}
      <p>{item.sourceId}{item.locator && ' · ' + item.locator}</p>
      {item.observedAt && <p>Received by PackProof · {new Date(item.observedAt).toLocaleString()}</p>}
      {item.profileVersion && <p>Reader · {item.profileVersion}</p>}
      {item.fields && item.fields.length>0 && <ul>{item.fields.map(field=><li key={JSON.stringify([field.scope,field.field])}>
        {field.scope} · {field.field} · {String(field.previous ?? 'unreported')} → {String(field.current ?? 'unreported')}
      </li>)}</ul>}
    </li>)}</ul>
  </details>;
}
