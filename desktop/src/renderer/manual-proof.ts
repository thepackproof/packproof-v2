import type {TransactionWriteInput} from '../../../web/src/api/types';
import {completeCreation,creationOperation,draftStorageKey,pendingCreationRequest,readDraft,saveDraft,sameCreationRequest} from '../../../web/src/first-experience/state';

export type ManualProofFields={title:string;reference:string;tracking:string;carrier:string};
export const emptyManualProof:ManualProofFields={title:'',reference:'',tracking:'',carrier:''};
export function manualProofKey(apiScope:string,userId:string){return draftStorageKey(apiScope,userId,'desktop-manual');}
export function manualProofFields(input:TransactionWriteInput):ManualProofFields{
  return {title:input.itemTitle??'',reference:input.externalReference??'',tracking:input.shipping?.trackingNumber??'',carrier:input.shipping?.carrier??''};
}
export function restoreManualProof(key:string):ManualProofFields{
  const value=readDraft<ManualProofFields>(key);
  if(value&&Object.keys(emptyManualProof).every(name=>typeof value[name as keyof ManualProofFields]==='string'))return value as ManualProofFields;
  const pending=pendingCreationRequest(key);return pending?manualProofFields(pending):{...emptyManualProof};
}
export function manualProofRequest(fields:ManualProofFields):TransactionWriteInput{
  return {itemTitle:fields.title.trim(),externalReference:fields.reference.trim()||null,shipping:fields.tracking.trim()?{trackingNumber:fields.tracking.trim(),carrier:fields.carrier.trim()||null}:null};
}
export function saveManualProof(key:string,fields:ManualProofFields){
  if(!saveDraft(key,fields))throw new Error('This computer could not save your draft. Try again before creating the Proof.');
}
export function pendingManualProof(key:string,fields:ManualProofFields){
  const pending=pendingCreationRequest(key);return pending&&!sameCreationRequest(pending,manualProofRequest(fields))?pending:null;
}
/** The exact request and operation identity must be durable before any IPC send. */
export async function submitManualProof(key:string,userId:string,fields:ManualProofFields,create:(input:TransactionWriteInput,userId:string)=>Promise<{proofId:string}>){
  const request=manualProofRequest(fields);
  if(!request.itemTitle)throw new Error('Enter an item or shipment name.');
  saveManualProof(key,fields);
  const idempotencyKey=creationOperation(key,request);
  return create({...request,idempotencyKey},userId);
}
export {completeCreation as completeManualProof};
