import type { IdentifierResolution } from '../../../backend/src/identifiers/types';
import { formatWhen } from '../format';

export type IdentifierProjection = {schemaVersion:1;coverage:string;reviewRequired:boolean;observations:IdentifierResolution[]};
const states:Record<string,string>={MATCH:'Observed identifier matches the selected order',RESOLVED_PRODUCT:'Item details found in the connected store',CONFLICT:'This code does not match the selected order',AMBIGUOUS:'Several records use this code',STALE:'Item details may be out of date',FORBIDDEN:'Item details unavailable',UNKNOWN:'Code read; item details unavailable',UNSUPPORTED:'This code is not supported for item details'};
export function IdentifierDetails({value,onJump}:{value:IdentifierProjection|null|undefined;onJump?:(sessionId:string,milliseconds:number)=>void}) {
  if(!value)return null;
  return <details className="record-order-details identifier-details">
    <summary>Item and shipment identifiers{value.reviewRequired?' · review needed':''}</summary>
    {value.coverage!=='COMPLETE'&&<p className="note">{value.coverage==='UNAVAILABLE'?'Automatic item recognition was unavailable for this recording.':'Automatic item recognition covered part of this recording.'}</p>}
    {value.observations.map(row=><section key={row.observationId} className="stack identifier-observation">
      <p><strong>{states[row.state]??'Code observed'}</strong>{row.supplemental?' · added after the recording checkpoint':''}</p>
      {row.product&&<p>{row.product.title}{row.product.variant?` · ${row.product.variant}`:''}{row.product.sku?` · SKU ${row.product.sku}`:''}</p>}
      {row.identifiers.filter(identifier=>identifier.type!=='UNKNOWN').map((identifier,index)=><p className="meta" key={`${identifier.type}:${index}`}>{identifier.type.replaceAll('_',' ')}: {identifier.normalizedValue??identifier.value}{identifier.validationResult==='INVALID'?' · invalid identifier':''}</p>)}
      {row.expected.length>0&&<p className="note">Expected on the order: {row.expected.map(item=>[item.title,item.sku?`SKU ${item.sku}`:null,item.gtin?`GTIN ${item.gtin}`:null].filter(Boolean).join(' · ')).join('; ')}</p>}
      {row.product&&<p className="note">From {row.product.sourceKind==='ORDER_SNAPSHOT'?'the order snapshot':'the connected catalog'} · revision {row.product.sourceRevision}</p>}
      <p className="note">{row.observation.source==='ENCODED_VIDEO_FRAME'?'Read from the saved video':'Read from the camera preview'} · {row.observation.timestampOrigin==='ENCODED_MEDIA'?'video':'approximate video moment'} {time(row.observation.mediaTimeMs)}. Received {formatWhen(row.receivedAt)}.</p>
      {onJump&&(row as IdentifierResolution&{evidenceId?:string|null}).evidenceId&&<button type="button" className="btn btn-tertiary" onClick={()=>onJump(row.observation.captureSessionId,row.observation.mediaTimeMs)}>View this moment{row.observation.timestampOrigin==='ENCODED_MEDIA'?'':' (approximate)'}</button>}
      {row.decision&&<p className="note">Seller review: {row.decision.reason} · {formatWhen(row.decision.createdAt)}</p>}
    </section>)}
    {!value.observations.length&&<p className="note">No item codes were resolved. The recording remains the evidence.</p>}
    <p className="note">An identifier match does not establish authenticity, package contents, or quantity. Repeated sightings are not a count of shipped items.</p>
  </details>;
}
function time(milliseconds:number){const seconds=Math.max(0,Math.floor(milliseconds/1000));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}
