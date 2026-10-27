import { sha256Hex } from '../hash.js';
import { canonicalize } from '../canonical.js';
import { units,decimalString,type Stage } from './contracts.js';
export interface Assertion {id:string;record_id:string;order_line_id:string;line_external_id:string;fulfillment_id:string|null;fulfillment_external_id:string|null;stage:Stage;quantity:string|null;uom:string|null;item_id:string|null;}
export interface EnterpriseException {key:string;code:string;lineId:string|null;recordIds:string[];message:string;logic:string;}
export interface StageQuantity {quantity:string|null;uom:string|null;recordIds:string[];coverage:'PRESENT'|'UNKNOWN'|'CONFLICT';}
export interface ReconciledLine {id:string;externalId:string;itemIds:string[];stages:Partial<Record<Stage,StageQuantity>>;effectiveOrdered:StageQuantity;}
export function exception(code:string,lineId:string|null,records:string[],message:string,logic:string):EnterpriseException{
 const recordIds=[...new Set(records)].sort();return {key:sha256Hex(canonicalize({code,lineId,recordIds})),code,lineId,recordIds,message,logic};
}
export function reconcile(assertions:Assertion[]){
 const exceptions:EnterpriseException[]=[],lines:ReconciledLine[]=[],unknown:StageQuantity={quantity:null,uom:null,recordIds:[],coverage:'UNKNOWN'};
 for(const lineId of [...new Set(assertions.map(a=>a.order_line_id))]){
  const rows=assertions.filter(a=>a.order_line_id===lineId),stages:Partial<Record<Stage,StageQuantity>>={},items=[...new Set(rows.map(a=>a.item_id).filter((x):x is string=>!!x))];
  if(items.length>1)exceptions.push(exception('ITEM_ID_CONFLICT',lineId,rows.map(r=>r.record_id),'Sources use different item identifiers for this native line.','Resolve item identity before physical item claims.'));
  for(const stage of [...new Set(rows.map(r=>r.stage))]){
   const all=rows.filter(a=>a.stage===stage),records=[...new Set(all.map(r=>r.record_id))],present=all.filter(a=>a.quantity!==null),uoms=[...new Set(present.map(a=>a.uom))];let result:StageQuantity={...unknown,recordIds:records};
   if(present.length!==all.length||!present.length){stages[stage]=result;continue;}
   if(uoms.length!==1){exceptions.push(exception('UOM_CONVERSION_UNKNOWN',lineId,records,'Quantities have incompatible units.','No implicit unit conversion is performed.'));stages[stage]={...result,coverage:'CONFLICT'};continue;}
   if(present.some(r=>!r.fulfillment_id)&&present.some(r=>!!r.fulfillment_id)){exceptions.push(exception('QUANTITY_SCOPE_AMBIGUOUS',lineId,records,'Aggregate and fulfillment-specific snapshots overlap.','Do not add an order-wide snapshot to partial shipments.'));stages[stage]={...result,coverage:'CONFLICT'};continue;}
   const groups=new Map<string,Assertion[]>();for(const row of present){const k=row.fulfillment_id??'ORDER_SCOPE';groups.set(k,[...(groups.get(k)??[]),row]);}
   let total=0n,conflict=false;for(const group of groups.values()){const amounts=[...new Set(group.map(r=>units(r.quantity!).toString()))];if(amounts.length!==1){conflict=true;exceptions.push(exception('CONFLICTING_STAGE_QUANTITY',lineId,group.map(r=>r.record_id),'Snapshots disagree at the same stage and fulfillment.','Conflicting quantities are withheld pending a source correction.'));}else total+=BigInt(amounts[0]);}
   result={quantity:conflict?null:decimalString(total),uom:uoms[0],recordIds:records,coverage:conflict?'CONFLICT':'PRESENT'};stages[stage]=result;
  }
  const ordered=stages.AMENDED??stages.ORDERED??unknown;
  for(const [prior,next,code] of [['PICKED','LOADED','LOAD_QTY_DIFFERS_FROM_PICK'],['LOADED','ACKNOWLEDGED','ACK_QTY_DIFFERS_FROM_LOAD']] as const){
   const p=stages[prior],n=stages[next];if(p?.quantity!==null&&p?.quantity!==undefined&&n?.quantity!==null&&n?.quantity!==undefined){
    const refs=[...p.recordIds,...n.recordIds];if(p.uom!==n.uom)exceptions.push(exception('UOM_CONVERSION_UNKNOWN',lineId,refs,'Stages use different units and cannot be compared.','No implicit unit conversion is performed.'));
    else if(units(p.quantity)!==units(n.quantity))exceptions.push(exception(code,lineId,refs,prior+' reports '+p.quantity+' '+p.uom+'; '+next+' reports '+n.quantity+' '+n.uom+'.','Compare stage snapshots for the same native line and UOM. Partial fulfillment may explain differences; no fault is assigned.'));
   }
  }
  if(ordered.quantity!==null){const ack=stages.ACKNOWLEDGED;if(ack?.quantity!==null&&ack?.quantity!==undefined&&ack.uom===ordered.uom&&units(ack.quantity)<units(ordered.quantity))exceptions.push(exception('PARTIAL_FULFILLMENT_PENDING',lineId,[...ordered.recordIds,...ack.recordIds],'Acknowledged quantity is below current ordered quantity.','A documented partial fulfillment does not establish loss.'));}
  if(!stages.LOADED)exceptions.push(exception('LOAD_RECORD_NOT_FOUND',lineId,rows.map(r=>r.record_id),'No line-scoped load assertion is available.','Absence of an imported record is not zero loaded quantity.'));
  if(!stages.ACKNOWLEDGED)exceptions.push(exception('HANDOFF_RECORD_NOT_FOUND',lineId,rows.map(r=>r.record_id),'No line-scoped quantity acknowledgment is available.','A photo, signature or general handoff does not establish acknowledged line quantity.'));
  lines.push({id:lineId,externalId:rows[0].line_external_id,itemIds:items,stages,effectiveOrdered:ordered});
 }
 return {lines,exceptions};
}
