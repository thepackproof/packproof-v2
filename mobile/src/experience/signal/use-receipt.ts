import {useEffect,useState} from 'react';
import {usePackProof} from '../../app/PackProofProvider';
import {hasSignalReceipt} from './receipt';
const confirmed=new Set<string>();
export function useSignalReceipt(proofId:string,version:string,eligible:boolean){
 const app=usePackProof(),owner=`${app.apiBaseUrl}:${app.session?.userId}`,key=`${owner}:${proofId}:${version}`;
 const [result,setResult]=useState<string|null>(null);
 useEffect(()=>{let active=true;if(!eligible)return;if(confirmed.has(key)){setResult(key);return;}
  void Promise.all([app.client.getProof(proofId),app.client.getProofRecovery(proofId)]).then(([proof,recovery])=>{const evidence=proof.evidence.find(item=>item.evidenceType==='FULFILLMENT_CAPTURE'&&item.validationStatus==='COMMITTED');if(active&&evidence&&hasSignalReceipt(proof,recovery,{proofId,evidenceId:evidence.evidenceId})){if(confirmed.size>256)confirmed.clear();confirmed.add(key);setResult(key);}}).catch(()=>{});
  return()=>{active=false;};
 },[key,eligible,app.client,proofId]);
 return eligible&&result===key;
}
