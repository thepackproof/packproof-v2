import {useEffect,useState} from 'react';
import type {PackProofApi} from '../api/client';
import {hasSignalReceipt} from '../../../mobile/src/experience/signal/receipt';
const confirmed=new WeakMap<PackProofApi,Set<string>>();
export function useSignalReceipt(api:PackProofApi|undefined,proofId:string,version:string,eligible:boolean){
 const key=`${proofId}:${version}`;const [result,setResult]=useState<{api:PackProofApi;key:string}|null>(null);
 useEffect(()=>{let active=true;if(!api||!eligible)return;
  if(confirmed.get(api)?.has(key)){setResult({api,key});return;}
  void Promise.all([api.getProof(proofId),api.getRecoveryStatus(proofId)]).then(([proof,recovery])=>{const evidence=proof.evidence.find(item=>item.evidenceType==='FULFILLMENT_CAPTURE'&&item.validationStatus==='COMMITTED');if(active&&evidence&&hasSignalReceipt(proof,recovery,{proofId,evidenceId:evidence.evidenceId})){let values=confirmed.get(api);if(!values){values=new Set();confirmed.set(api,values);}if(values.size>256)values.clear();values.add(key);setResult({api,key});}}).catch(()=>{});
  return()=>{active=false;};
 },[api,key,eligible,proofId]);
 return eligible&&result?.api===api&&result?.key===key;
}
