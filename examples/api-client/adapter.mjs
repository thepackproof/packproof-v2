// Trusted-server reference intake. The merchant stores its order-to-Proof mapping.
import {readFile} from 'node:fs/promises';
import {PackProofClient} from './client.mjs';
const profile=process.env.PACKPROOF_API_PROFILE??'legacy';
if(!['legacy','partner'].includes(profile))throw new Error('Choose legacy or partner profile');
if(!process.env.PACKPROOF_ORDER_FILE||!process.env.PACKPROOF_OPERATION_KEY)throw new Error('Supply a confirmed order file and persisted operation key');
const bytes=await readFile(process.env.PACKPROOF_ORDER_FILE);if(bytes.length>65536)throw new Error('Order exceeds bounded example input');
const client=new PackProofClient({apiOrigin:process.env.PACKPROOF_API_ORIGIN,credential:process.env.PACKPROOF_API_KEY,merchantId:process.env.PACKPROOF_MERCHANT_ID,delegationId:process.env.PACKPROOF_DELEGATION_ID});
const result=await client.request(profile==='partner'?'partner.post__v1_partner_proofs':'legacy.post_proofs',{key:process.env.PACKPROOF_OPERATION_KEY,body:JSON.parse(bytes.toString('utf8'))});
console.log(JSON.stringify({proofId:profile==='partner'?result.proofId:result.proof.proofId,...(profile==='partner'?{created:result.created}:{status:result.proof.status,capture:result.links.capture,viewer:result.links.viewer})},null,2));
