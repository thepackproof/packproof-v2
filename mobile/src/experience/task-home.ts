/** A recommendation is presentation only. Adapters authorize inputs; routers revalidate on tap. */
export interface HomeProof { id:string; title:string; status:string; authorized:boolean; action:'capture'|'continue'|'finalize'|'view'|'unknown'; createdAt:string; updatedAt:string; completed:boolean; continuationAfterFinalization?:boolean; }
export interface HomeCapture { id:string; proofId:string; usable:boolean; needsReview:boolean; authorized:boolean; interrupted?:boolean; }
export interface HomeJob { id:string; proofId:string; authorized:boolean; active:boolean; waiting:boolean; intervention:boolean; reason?:string; }
export interface HomeOrder { id:string; proofId:string; title:string; ready:boolean; authorized:boolean; createdAt:string; }
export type HomeActionKind = 'review_evidence'|'review_upload'|'continue_proof'|'finalize_proof'|'start_packing'|'create_proof'|'reconcile';
export interface HomeAction { kind:HomeActionKind; targetId:string|null; sessionId?:string; title:string; reason:string; buttonLabel:string; count:number; sourceFreshness:'server'|'cached'|'device'|'unknown'; rank:number; }
export interface HomeInput { proofs:HomeProof[]; captures:HomeCapture[]; jobs:HomeJob[]; orders:HomeOrder[]; online:boolean; reconciled:boolean; selection?:string|null; interactions?:Record<string,number>; }
const known = new Set(['OPEN','AWAITING_PARTICIPANT','READY_FOR_EVIDENCE','EVIDENCE_COMMITTED','FINALIZED']);
const time = (value:string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : Number.MAX_SAFE_INTEGER;
export const actionIdentity = (action:HomeAction) => `${action.kind}:${action.targetId ?? ''}:${action.sessionId ?? ''}`;

export function selectTaskHome(input:HomeInput) {
  const proofs = new Map(input.proofs.filter(p=>p.authorized).map(p=>[p.id,p]));
  const fresh = input.reconciled ? 'server' : 'cached';
  const actions:HomeAction[]=[];
  const attentionIds=new Set<string>();
  const readyOrders=new Set(input.orders.filter(o=>o.authorized&&o.ready).map(o=>o.proofId));
  const add = (p:HomeProof, kind:HomeActionKind, rank:number, buttonLabel:string, reason:string, sessionId?:string) => {attentionIds.add(p.id);actions.push({kind,rank,buttonLabel,reason,targetId:p.id,title:p.title || 'Shipment Proof',sessionId,count:1,sourceFreshness:sessionId?'device':fresh});};
  const jobs = [...new Map(input.jobs.filter(j=>j.authorized && proofs.has(j.proofId)).map(j=>[j.id,j])).values()];
  for (const p of proofs.values()) {
    if (!known.has(p.status) || p.action==='unknown' || (p.status==='FINALIZED' && !p.completed)) {
      add(p,'reconcile',7,'Refresh Proof','The current state needs to be checked with PackProof.');
      continue;
    }
    // A finalized root never receives capture or upload recommendations. Later stages use their own workflow.
    if (p.status==='FINALIZED' || p.completed) {
      if(p.continuationAfterFinalization && p.action==='continue') {attentionIds.add(p.id);if(input.online&&input.reconciled)add(p,'continue_proof',3,'Continue Proof','Continue the authorized receipt or return stage. The finalized record stays unchanged.');}
      continue;
    }
    const captures = input.captures.filter(c=>c.authorized && c.proofId===p.id);
    const review = captures.filter(c=>c.usable && c.needsReview && !c.interrupted).sort((a,b)=>a.id.localeCompare(b.id));
    if (review.length) { add(p,'review_evidence',1,'Review evidence','Evidence saved on device. Review it before submission.',review[0].id); continue; }
    const failure = jobs.filter(j=>j.proofId===p.id && j.intervention).sort((a,b)=>a.id.localeCompare(b.id));
    if (failure.length) { add(p,'review_upload',2,'Review upload',failure[0].reason || 'Your saved work needs an action to continue.',failure[0].id); continue; }
    if (captures.some(c=>c.interrupted || !c.usable)) { add(p,'review_upload',2,'Review recovery','An interrupted recording needs review before a new recording can start.',captures[0]?.id); continue; }
    if (jobs.some(j=>j.proofId===p.id) || captures.length) continue; // Normal coordinator work stays passive.
    if (["capture","continue","finalize"].includes(p.action) || readyOrders.has(p.id))attentionIds.add(p.id);
    if (!input.online || !input.reconciled) continue;
    if(p.action==='capture' && readyOrders.has(p.id))continue;
    if (p.action==='capture' || p.action==='continue') add(p,'continue_proof',3,'Continue Proof','Continue the next available step for this Proof.');
    else if (p.action==='finalize') add(p,'finalize_proof',4,'Finalize Proof','Committed evidence is ready for the required confirmation.');
  }
  if (input.online && input.reconciled) for (const order of input.orders) {
    const p=proofs.get(order.proofId);
    if (!order.authorized || !order.ready || !p || p.completed || p.status==='FINALIZED' || !known.has(p.status) || p.action==='unknown' || actions.some(a=>a.targetId===p.id) || jobs.some(j=>j.proofId===p.id) || input.captures.some(c=>c.authorized&&c.proofId===p.id)) continue;
    add({...p,title:order.title},'start_packing',5,'Start packing','This shipment is ready for packing evidence.');
  }
  actions.sort((a,b)=>a.rank-b.rank || Number(b.targetId===input.selection)-Number(a.targetId===input.selection) || (input.interactions?.[b.targetId!] ?? 0)-(input.interactions?.[a.targetId!] ?? 0) || time(proofs.get(a.targetId!)!.createdAt)-time(proofs.get(b.targetId!)!.createdAt) || a.targetId!.localeCompare(b.targetId!) || (a.sessionId??'').localeCompare(b.sessionId??''));
  for (const action of actions) action.count=actions.filter(other=>other.kind===action.kind).length;
  const create:HomeAction={kind:'create_proof',targetId:null,rank:6,title:!proofs.size && input.reconciled?'Create your first Proof':'Create a Proof',reason:input.online?'Record the item, packing, seal, and label in one continuous video.':'Connect before creating a Proof. Your saved work remains available.',buttonLabel:'Create Proof',count:1,sourceFreshness:input.reconciled?'server':'unknown'};
  return {recommendation:actions.find(a=>a.rank<6) ?? (actions.find(a=>a.kind==='reconcile') || create), actions, counts:{attention:attentionIds.size,uploading:jobs.filter(j=>j.active).length,waiting:jobs.filter(j=>j.waiting&&!j.active).length,completed:[...proofs.values()].filter(p=>p.status==='FINALIZED'&&p.completed).length}};
}

/** Pin a still-valid target during focus/press; never retain a target which became invalid. */
export function stableRecommendation(previous:HomeAction|null,next:ReturnType<typeof selectTaskHome>,interacting:boolean):HomeAction {
  return interacting && previous ? next.actions.find(a=>actionIdentity(a)===actionIdentity(previous)) ?? next.recommendation : next.recommendation;
}
