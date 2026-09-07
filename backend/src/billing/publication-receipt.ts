import { open } from 'node:fs/promises';
import type { Clock } from '../clock.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { DomainError } from '../domain/errors.js';
import type { OfferDefinition } from './usage-ledger.js';

export interface PublicationReceiptInput { receipt: unknown; trustedReceiptSha256: string; expectedReleaseSha: string; }
export interface ApprovedOfferOptions { publication?: PublicationReceiptInput; }
function fail():never{throw new DomainError('BILLING_PUBLICATION_APPROVAL_REQUIRED','Approved offer publication requires a current independently pinned policy receipt matching these exact terms',409);}
/** Trusted internal receipt injection is for reviewed provisioning/test adapters.
 * HTTP callers must never choose a receipt, its pin, or publication authority.
 */
export function validatePublicationReceipt(offer:OfferDefinition,clock:Clock,input:PublicationReceiptInput){
  if(!input.receipt||typeof input.receipt!=='object'||Array.isArray(input.receipt))fail();
  const receipt=input.receipt as Record<string,unknown>;
  const {receiptSha256,...payload}=receipt;
  if(!/^[a-f0-9]{64}$/.test(input.trustedReceiptSha256)||receiptSha256!==input.trustedReceiptSha256||sha256Hex(canonicalize(payload))!==receiptSha256)fail();
  const evaluated=Date.parse(String(receipt.evaluatedAt)),expires=Date.parse(String(receipt.expiresAt)),now=clock.now().getTime();
  if(typeof input.expectedReleaseSha!=='string'||!/^[a-f0-9]{40}$/.test(input.expectedReleaseSha)||receipt.releaseSha!==input.expectedReleaseSha)fail();
  if(receipt.schemaVersion!=='packproof.publication-policy-receipt.v1'||receipt.state!=='passed'||receipt.offerVersion!==offer.version||receipt.approvedTermsReference!==offer.approvedTermsReference
    ||receipt.canonicalOfferSha256!==sha256Hex(canonicalize(offer))||!Number.isFinite(evaluated)||!Number.isFinite(expires)||evaluated>now||expires<=now||expires<=evaluated||expires-evaluated>86400000)fail();
  for(const key of ['entitySha256','supportEvidenceSha256','approvalRegistrySha256'])if(typeof receipt[key]!=='string'||!/^[a-f0-9]{64}$/.test(receipt[key] as string))fail();
  if(!receipt.documents||typeof receipt.documents!=='object'||Array.isArray(receipt.documents))fail();
  for(const name of ['terms','privacy','support']){
    const document=(receipt.documents as Record<string,unknown>)[name];if(!document||typeof document!=='object'||Array.isArray(document))fail();const row=document as Record<string,unknown>;
    if(typeof row.version!=='string'||!row.version||typeof row.approvalReference!=='string'||!row.approvalReference)fail();
    for(const key of ['artifactSha256','approvalRecordSha256'])if(typeof row[key]!=='string'||!/^[a-f0-9]{64}$/.test(row[key] as string))fail();
    const verified=Date.parse(String(row.verifiedAt));if(!Number.isFinite(verified)||verified>evaluated||evaluated-verified>86400000)fail();
    let url:URL;try{url=new URL(String(row.servedUrl));}catch{fail();}if(url!.protocol!=='https:'||url!.username||url!.password)fail();
  }
  return {receiptSha256:input.trustedReceiptSha256,evaluatedAt:new Date(evaluated).toISOString(),expiresAt:new Date(expires).toISOString()};
}
async function configuredReceipt():Promise<PublicationReceiptInput>{
  const file=process.env.PACKPROOF_PUBLICATION_RECEIPT_FILE,pin=process.env.PACKPROOF_PUBLICATION_RECEIPT_SHA256,expectedReleaseSha=process.env.PACKPROOF_RELEASE_SHA;
  if(!file||!pin||!expectedReleaseSha)fail();
  let handle:Awaited<ReturnType<typeof open>>|undefined;
  try{handle=await open(file,'r');const stat=await handle.stat();if(!stat.isFile()||stat.size>65536)fail();const chunks:Buffer[]=[];let bytes=0;
    for await(const chunk of handle.createReadStream({highWaterMark:16384,autoClose:false})){bytes+=chunk.length;if(bytes>65536)fail();chunks.push(chunk as Buffer);}
    return{receipt:JSON.parse(Buffer.concat(chunks).toString('utf8')),trustedReceiptSha256:pin,expectedReleaseSha};
  }catch{return fail();}finally{await handle?.close();}
}
export async function requireOfferPublication(offer:OfferDefinition,clock:Clock,options?:ApprovedOfferOptions){return validatePublicationReceipt(offer,clock,options?.publication??await configuredReceipt());}
