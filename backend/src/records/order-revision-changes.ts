import {canonicalize} from '../canonical.js';
import type {projectOrders} from './order-projection.js';

type Event = ReturnType<typeof projectOrders>['projections'][number]['events'][number];
const identity = (e: Event) => JSON.stringify([e.sourceId,e.eventId]);
export function revisionChanges(before: Event[], after: Event[]) {
  const previous = new Map(before.map(e=>[identity(e),e]));
  const changes = [];
  for (const event of after) {
    const key=identity(event), old=previous.get(key);
    previous.delete(key);
    if (old?.eventKey===event.eventKey && old.associationScope===event.associationScope &&
        canonicalize(old.lines)===canonicalize(event.lines) && canonicalize(old.fields)===canonicalize(event.fields)) continue;
    const fields: Array<{scope:string;field:string;previous?:unknown;current?:unknown}> = [];
    if (old && old.associationScope==='order' && event.associationScope==='order') {
      const diff=(scope:string,a:Record<string,unknown>,b:Record<string,unknown>)=>{
        for (const field of new Set([...Object.keys(a),...Object.keys(b)])) {
          if(a[field]===b[field]) continue;
          fields.push({scope,field,...(field in a?{previous:a[field]}:{}),...(field in b?{current:b[field]}:{})});
        }
      };
      diff('record',old.fields,event.fields);
      const oldLines=new Map(old.lines.map(l=>[l.lineId,l]));
      const newLines=new Map(event.lines.map(l=>[l.lineId,l]));
      for (const id of new Set([...oldLines.keys(),...newLines.keys()])) diff('line/'+id,oldLines.get(id)??{},newLines.get(id)??{});
    }
    changes.push({kind:old?'updated':'added',subject:event.entity,eventKey:event.eventKey,
      ...(old?{previousEventKey:old.eventKey}:{}),sourceId:event.sourceId,profileVersion:event.profileVersion,
      observedAt:event.observedAt,locator:event.locator,originalSha256:event.originalSha256,fields});
  }
  for (const event of previous.values()) changes.push({kind:'unlinked',subject:event.entity,previousEventKey:event.eventKey,
    sourceId:event.sourceId,profileVersion:event.profileVersion});
  return changes;
}
