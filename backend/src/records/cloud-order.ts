import type {AppDependencies} from '../app.js';
import type {Database} from '../db/database.js';
import {DomainError} from '../domain/errors.js';
import {sha256Hex} from '../hash.js';
import {canonicalize} from '../canonical.js';
import {newId} from '../ids.js';
import {importPartnerOrder} from '../platform/partner-proofs.js';
import type {PartnerActor} from '../platform/organizations.js';
import {operationKey} from './order-workspace.js';
import {preserveOrderOriginal,ensureOrderRoot,insertOrderEvent,orderComponent,lockOperation,commitOrderGroup} from './order-ledger.js';
import {normalizedRecord,refKey} from './order-projection.js';
import {reconstructionFeatureEnabled} from './reconstruction-features.js';

/** The public order import already creates its canonical Proof. Retain the exact
 * authorized API submission and publish a first revision on that existing ID. */
export async function importCloudOrder(deps:AppDependencies,tx:Database,a:PartnerActor,input:unknown,bytes:Buffer|undefined){
 if(!reconstructionFeatureEnabled('orderWorkspace')||a.delegationGrantId)return importPartnerOrder(tx,deps.clock,a,input);
 const body=input as {integrationAccountId?:unknown;operatorMembershipId?:unknown;externalId?:unknown;transaction?:{itemTitle?:unknown;quantity?:unknown}};
 // Leave malformed inputs to the normal endpoint validator.
 if(typeof body?.integrationAccountId!=='string'||typeof body?.operatorMembershipId!=='string'||typeof body?.externalId!=='string')return importPartnerOrder(tx,deps.clock,a,input);
 const o={organization:a.merchantId,environment:a.environment,account:body.integrationAccountId,operator:body.operatorMembershipId,location:null,operation:operationKey(a.merchantId,a.environment,body.operatorMembershipId,body.integrationAccountId,null)};
 await lockOperation(tx,o.operation);
 const result=await importPartnerOrder(tx,deps.clock,a,input);
 if(!result.created)return result; // Earlier submissions have no recoverable original wire bytes on this request.
 if(!bytes)throw new DomainError('IMPORT_ORIGINAL_UNVERIFIED','The original order submission could not be retained. Retry the submission.',503);
 const sha=sha256Hex(bytes),stored=await preserveOrderOriginal(deps,o.organization,sha,bytes,'application/json'),sourceId='api:'+o.account;
 const facts:Record<string,string>={};if(typeof body.transaction?.itemTitle==='string')facts.itemTitle=body.transaction.itemTitle;
 if(body.transaction?.quantity!==undefined)facts.quantity=String(body.transaction.quantity);
 const record=normalizedRecord({eventId:result.proofId,version:'1',kind:'order',entity:{namespace:o.account,type:'order',id:body.externalId},references:[],fields:facts,locator:'$.transaction'});
 const id=newId('order_receipt'),now=deps.clock.now().toISOString();
 await tx.query(`INSERT INTO record_order_receipts(id,operation_key,source_id,generation,observation_id,payload_digest,original_sha256,object_key,object_version,file_name,media_type,profile_version,issues,received_at)
 VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,'order.json','application/json','packproof.partner-order/v1','[]'::jsonb,$9)`,[id,o.operation,sourceId,result.proofId,sha256Hex(canonicalize(input)),sha,stored.key,stored.version,now]);
 await ensureOrderRoot(tx,deps.clock,a,o,sourceId,record,result.proofId);await insertOrderEvent(tx,o.operation,sourceId,id,record);
 const group=await orderComponent(tx,o.operation,[refKey(record.entity)]);
 await commitOrderGroup(tx,deps.clock,o.operation,group,a.actorUserId);
 return result;
}
