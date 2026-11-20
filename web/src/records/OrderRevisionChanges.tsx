import { useState } from 'react';
import type { PackProofApi } from '../api/client';
import { revisionPath } from './OrderEvidence';
import { displayState } from './model';
import { useWorkflowData } from './workflow';

interface HistoryEvent {
  eventKey?:string;eventId?:string;sourceId:string;kind:string;version?:string;observedAt?:string;
  locator?:string;profileVersion?:string;fields:Record<string,unknown>;
  lines?:Record<string,unknown>[];entity?:{id:string};
}
interface Revision {proofId:string;revision:number;events:HistoryEvent[]}
function identity(e:HistoryEvent) {return JSON.stringify([e.sourceId,e.eventId || e.eventKey]);}
function amounts(rows:Record<string,unknown>[] = []) {
  return Object.fromEntries(rows.flatMap(line=>Object.entries(line).filter(([key])=>key !== 'lineId')
    .map(([key,value])=>[String(line.lineId) + ' · ' + key,value])));
}
export function OrderRevisionChanges({api,scope,current}: {api:PackProofApi;scope:string;current:Revision}) {
  const [open,setOpen] = useState(false);
  const previous = useWorkflowData<Revision>(api,open && current.revision>1 ? revisionPath(current.proofId,current.revision-1)+'?'+scope : null);
  if (current.revision <= 1) return <p>First recorded revision.</p>;
  const before = previous.data?.proofId === current.proofId && previous.data.revision === current.revision-1 ? previous.data : null;
  const old = new Map(before?.events.map(e=>[identity(e),e]));
  const keys = new Set(current.events.map(identity));
  const changes = current.events.flatMap(event=>{
    const prior=old.get(identity(event));
    if (prior?.eventKey === event.eventKey && prior?.version === event.version && prior) return [];
    const oldFields={...prior?.fields,...amounts(prior?.lines)}, newFields={...event.fields,...amounts(event.lines)};
    return [{event,status:prior ? 'Corrected' : 'Added',differences:prior ?
      [...new Set([...Object.keys(oldFields),...Object.keys(newFields)])].filter(k=>oldFields[k]!==newFields[k])
        .map(k=>k + ' · ' + String(oldFields[k] ?? 'unreported') + ' → ' + String(newFields[k] ?? 'unreported')) : []}];
  });
  return <details onToggle={e=>setOpen(e.currentTarget.open)}><summary>What changed since revision {current.revision-1}?</summary>
    {previous.error ? <p role="alert">{previous.error}</p> : !before ? <p role="status">Checking the earlier revision…</p> : <>
      <ul>{changes.map(({event,status,differences})=><li key={identity(event)}><strong>{status} · {displayState(event.kind)}</strong>
        {event.entity?.id && ' · ' + event.entity.id}<p>{event.sourceId} · {event.locator || 'No locator reported'}</p>
        {event.observedAt && <p>Received by PackProof · {new Date(event.observedAt).toLocaleString()}</p>}
        {event.profileVersion && <p>Reader · {event.profileVersion}</p>}
        {differences.length > 0 && <ul>{differences.map(item=><li key={item}>{item}</li>)}</ul>}
      </li>)}
      {before.events.filter(e=>!keys.has(identity(e))).map(e=><li key={identity(e)}>Removed from this order · {displayState(e.kind)} · {e.sourceId}</li>)}</ul>
      {changes.length===0 && before.events.every(e=>keys.has(identity(e))) && <p>Event versions are unchanged. Open the previous revision to compare its linked evidence.</p>}
    </>}
  </details>;
}
