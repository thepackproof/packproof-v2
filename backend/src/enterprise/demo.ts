import { canonicalMapping } from './contracts.js';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import type { ObjectStore } from '../s3/object-store.js';
import { DomainError } from '../domain/errors.js';
import { createSource,addMapping,requireSite,type EnterpriseActor } from './access.js';
import { prepareImport,commitImport } from './imports.js';
export function syntheticRecords(){
 const line=(o:string,q:string)=>({order_id:o,line_id:'1',item_id:'SYNTHETIC-VALVE-1',quantity:q,uom:'EA'});
 const row=(key:string,order:string,stage:string,qty:string,fulfillment:string|null,day=14)=>({record_key:key,revision:'1',stage,order_id:order,fulfillment_id:fulfillment,occurred_at_local:'2026-10-'+day+'T09:00:00',source_timezone:'America/New_York',lines:[line(order,qty)],document_keys:stage==='ACKNOWLEDGED'?['synthetic-'+order+'.pdf']:[]});
 return [
 row('normal-order','SYNTH-NORMAL','ORDERED','10',null),row('normal-pick','SYNTH-NORMAL','PICKED','10','SYN-SHIP-N'),row('normal-load','SYNTH-NORMAL','LOADED','10','SYN-SHIP-N'),row('normal-ack','SYNTH-NORMAL','ACKNOWLEDGED','10','SYN-SHIP-N'),
 row('split-order','SYNTH-SPLIT','ORDERED','10',null),row('split-pick-a','SYNTH-SPLIT','PICKED','4','SYN-SHIP-A'),row('split-load-a','SYNTH-SPLIT','LOADED','4','SYN-SHIP-A'),row('split-ack-a','SYNTH-SPLIT','ACKNOWLEDGED','4','SYN-SHIP-A'),
 row('split-pick-b','SYNTH-SPLIT','PICKED','6','SYN-SHIP-B',15),row('split-load-b','SYNTH-SPLIT','LOADED','6','SYN-SHIP-B',15),row('split-ack-b','SYNTH-SPLIT','ACKNOWLEDGED','6','SYN-SHIP-B',15),
 row('variance-order','SYNTH-VARIANCE','ORDERED','10',null),row('variance-pick','SYNTH-VARIANCE','PICKED','10','SYN-SHIP-X'),row('variance-load','SYNTH-VARIANCE','LOADED','8','SYN-SHIP-X'),
 {record_key:'ambiguous-load',revision:'1',stage:'LOADED',candidate_order_ids:['SYNTH-NORMAL','SYNTH-VARIANCE'],lines:[{line_id:'1',quantity:'2',uom:'EA'}],occurred_at_local:'2026-10-14T09:20:00'}];
}
export function syntheticTicket(order:string){
 const rows=['SYNTHETIC TRAINING RECORD - NOT WINSUPPLY DATA','Order '+order,'Illustrative source acknowledgment only.',order==='SYNTH-SPLIT'?'Release A: 4 EA; release B: 6 EA.':'Release N: 10 EA.','PackProof does not assert physical delivery.'];
 const stream='BT /F1 12 Tf 40 740 Td '+rows.map((s,i)=>(i?'0 -28 Td ':'')+'('+s.replace(/[()\\]/g,'')+') Tj').join('\n')+' ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length '+Buffer.byteLength(stream)+' >>\nstream\n'+stream+'\nendstream'];
 let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=(i+1)+' 0 obj\n'+o+'\nendobj\n';});const start=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+start+'\n%%EOF\n';return Buffer.from(pdf);
}
export function syntheticEnvelope(sourceId:string){return {schemaVersion:'packproof.enterprise.import/v1',sourceId,mappingVersion:'1',format:'JSON',synthetic:true,contentBase64:Buffer.from(JSON.stringify(syntheticRecords(),null,2)).toString('base64'),files:['SYNTH-NORMAL','SYNTH-SPLIT'].map(o=>({documentKey:'synthetic-'+o+'.pdf',contentType:'application/pdf',base64:syntheticTicket(o).toString('base64')}))};}
export async function loadSyntheticExamples(db:Database,clock:Clock,store:ObjectStore,a:EnterpriseActor,siteId:string){
 const site=await requireSite(db,clock,a,siteId,['ADMIN']);if(site.mode!=='SYNTHETIC')throw new DomainError('SYNTHETIC_SITE_REQUIRED','Demo records require a synthetic site',409);
 const source=await createSource(db,clock,a,siteId,{name:'Synthetic fulfillment training export',freshnessHours:8760});
 await addMapping(db,clock,a,source.id,{mapping:canonicalMapping,approvalReference:'SYNTHETIC_FIXTURE_CONTRACT_ONLY'});const input=syntheticEnvelope(source.id),preview=await prepareImport(db,clock,a,input);return commitImport(db,clock,store,a,{...input,previewDigest:preview.previewDigest});
}
