import type { DraftPreview } from "../workspace-types";
import { quantityStages } from "./ProofModel";
import { kindNames } from "./SetupParts";

type Order = DraftPreview["examples"][number];
export function eventFacts(event:Order["events"][number]) {
  const kind=kindNames[event.kind]?.[1] || event.kind;
  const amounts=(event.lines ?? []).flatMap(line=>quantityStages.filter(([key])=>line[key]!==undefined).map(([key,label])=>{
    const carton=line.packageId || line.cartonId || line.packageReference;
    return [line.sku || line.lineId,label.toLowerCase(),line[key],line.unit,carton && "in carton "+carton].filter(Boolean).join(" ");
  }));
  const occurred=event.occurredAt ? new Date(event.occurredAt) : null;
  const when=occurred && Number.isFinite(occurred.getTime()) ? occurred.toLocaleString(undefined,{dateStyle:"medium",timeStyle:"long"}) : event.occurredAt;
  return [
    [kind,event.entity?.id,when].filter(Boolean).join(" · "),
    ...amounts,...(event.qualifiedWeight && event.qualifiedWeightUnit ? [event.qualifiedWeight+" "+event.qualifiedWeightUnit] : []),
  ].join(" · ");
}
function facts(order:Order|undefined,sourceId:string) {
  if(!order) return ["Order absent from sample"];
  return [
    ...order.events.filter(e=>e.sourceId===sourceId).map(eventFacts),
    ...(order.cartons ?? []).map(c=>[c.id,c.status==="delivered"?"Delivery confirmed":"Awaiting delivery evidence",
      c.lastKind && (kindNames[c.lastKind]?.[1] ?? c.lastKind)].filter(Boolean).join(" · ")),
  ].sort();
}
function difference(left:string[],right:string[]) {
  const remaining=[...right];
  return left.filter(item=>{
    const at=remaining.indexOf(item);
    if(at<0) return true;
    remaining.splice(at,1);return false;
  });
}
export function RuleImpact({previous,current,sourceId}:{previous:DraftPreview;current:DraftPreview;sourceId:string}) {
  if(!current.sampleBasis || current.sampleBasis!==previous.sampleBasis) return <p role="status">The samples could not be held constant. Compare again once the source files are stable.</p>;
  const key=(o:Order)=>JSON.stringify([o.orderNamespace,o.orderId ?? o.orderReference]);
  const before=new Map(previous.examples.map(o=>[key(o),o]));
  const after=new Map(current.examples.map(o=>[key(o),o]));
  const matched=new Set([...before.keys(),...after.keys()]);
  const rows=[...matched].flatMap(id=>{
    const former=before.get(id),next=after.get(id);
    const left=facts(former,sourceId),right=facts(next,sourceId);
    if(JSON.stringify(left)===JSON.stringify(right)) return [];
    const a=next ?? former!;
    return [{id,name:a.displayReference || a.orderReference,source:a.source,removed:difference(left,right),added:difference(right,left)}];
  });
  return <section className="setup-card guided-form" aria-label="Rule impact on sampled orders">
    <h3>What changed in this sample?</h3>
    <p>{rows.length} of {matched.size} sampled orders changed under this rule.</p>
    {rows.map(r=><div key={r.id}><strong>{r.name}</strong><small> · {r.source}</small>
      <dl className="guided-compare"><dt>Before</dt><dd>{r.removed.length?r.removed.join(" / "):"No corresponding claim"}</dd>
        <dt>After</dt><dd>{r.added.length?r.added.join(" / "):"No corresponding claim"}</dd></dl>
    </div>)}
    <small>{current.scannedFiles} files sampled. This comparison covers the events and cartons shown in the preview.</small>
  </section>;
}
