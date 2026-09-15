import {DomainError} from '../domain/errors.js';
import {previewOrderIntake} from './order-intake.js';

export const MAX_INTAKE_CHARACTERS=20_000;
export const MAX_INTAKE_BYTES=65_536;
export type IntakeProvider='ebay'|'shopify'|'etsy';
export interface SubmissionEnvelope {
 schemaVersion:1;clientSubmissionId:string;surface:'ANDROID_SHARE'|'IOS_SHARE'|'EXPLICIT_PASTE';requestedAction:'QUEUE';
 payload:{kind:'TEXT'|'URL';text:string};hints?:{provider?:IntakeProvider;connectionId?:string};
}
export interface SubmissionHints {provider:IntakeProvider|null;connectionId:string|null;accountReference:string|null;reference:string|null;proofId:string|null;listing:boolean;storeHandle:string|null;itemTitle:string|null}
export function strictRecord(value:unknown,keys:readonly string[]):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))
  throw new DomainError('INVALID_INTAKE','Order intake contains unsupported fields.',400);
 return value as Record<string,unknown>;
}
export function parseSubmissionEnvelope(input:unknown):SubmissionEnvelope {
 const body=strictRecord(input,['schemaVersion','clientSubmissionId','surface','requestedAction','payload','hints']);
 if(Buffer.byteLength(JSON.stringify(body),'utf8')>MAX_INTAKE_BYTES)throw new DomainError('INPUT_TOO_LARGE','Share at most 20,000 characters and 64 KiB.',413);
 const payload=strictRecord(body.payload,['kind','text']);
 if(typeof payload.text==='string'&&payload.text.length>MAX_INTAKE_CHARACTERS)throw new DomainError('INPUT_TOO_LARGE','Share at most 20,000 characters and 64 KiB.',413);
 if(body.schemaVersion!==1||typeof body.clientSubmissionId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.clientSubmissionId)||typeof body.surface!=='string'||!['ANDROID_SHARE','IOS_SHARE','EXPLICIT_PASTE'].includes(body.surface)||body.requestedAction!=='QUEUE'||typeof payload.kind!=='string'||!['TEXT','URL'].includes(payload.kind)||typeof payload.text!=='string'||!payload.text.trim()||/[\u0000\ud800-\udfff]/u.test(payload.text.replace(/[\u{10000}-\u{10ffff}]/gu,'')))
  throw new DomainError('INVALID_INTAKE','Share valid text or a web link using a stable submission ID.',400);
 const hints=body.hints===undefined?undefined:strictRecord(body.hints,['provider','connectionId']);
 if(hints?.provider!==undefined&&(typeof hints.provider!=='string'||!['ebay','shopify','etsy'].includes(hints.provider)))throw new DomainError('INVALID_INTAKE','The provider hint is not supported.',400);
 if(hints?.connectionId!==undefined&&(typeof hints.connectionId!=='string'||!hints.connectionId||hints.connectionId.length>200))throw new DomainError('INVALID_INTAKE','The connection hint is invalid.',400);
 const result={schemaVersion:1,clientSubmissionId:body.clientSubmissionId.toLowerCase(),surface:body.surface,requestedAction:'QUEUE',payload:{kind:payload.kind,text:payload.text.replace(/\r\n?/g,'\n').trim()},...(hints?{hints}:{})} as SubmissionEnvelope;
 if(result.payload.kind==='URL')safeWebUrl(result.payload.text);
 return result;
}
export function safeWebUrl(value:string):URL {
 let url:URL;try{url=new URL(value);}catch{throw new DomainError('INVALID_INTAKE_URL','Share a complete HTTPS or HTTP web link.',400);}
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new DomainError('INVALID_INTAKE_URL','This link cannot be used for order intake.',400);
 return url;
}
/** Classification only. Never fetch a URL, trust a claimed marketplace, or infer a sale from a listing. */
export function classifySubmission(envelope:SubmissionEnvelope):SubmissionHints {
 const raw=envelope.payload.text;
 const draft=previewOrderIntake({text:raw,source:envelope.surface==='EXPLICIT_PASTE'?'paste':'share'}).draft;
 const result:SubmissionHints={provider:envelope.hints?.provider??null,connectionId:envelope.hints?.connectionId??null,accountReference:null,reference:draft.externalReference,proofId:null,listing:false,storeHandle:null,itemTitle:draft.itemTitle};
 const urls=raw.match(/https?:\/\/[^\s<>"']+/gi)??[];
 // Multiple URLs remain reviewable. Only one exact source can establish an automatic candidate.
 if(urls.length>1){result.reference=null;return result;}
 if(urls.length===0){
  if(/^\s*[a-z][a-z0-9+.-]*:/i.test(raw)&&!/^(order|item|product|description|marketplace|platform|quantity|qty|tracking|total|currency|buyer|seller)\s*:/i.test(raw))safeWebUrl(raw);
  return result;
 }
 const url=safeWebUrl(urls[0]!);
 const host=url.hostname.toLowerCase();
 if(['thepackproof.com','www.thepackproof.com'].includes(host)){
  const match=/^\/(?:app\/)?proofs\/(proof_[A-Za-z0-9]+)\/?$/.exec(url.pathname);
  result.proofId=match?.[1]??null;result.reference=null;return result;
 }
 if(/^(?:www\.)?(?:sandbox\.)?ebay\.com$/.test(host)){
  result.provider='ebay';result.listing=/^\/itm(?:\/|$)/.test(url.pathname);
  const order=url.searchParams.get('orderid')??url.searchParams.get('orderId');
  result.reference=!result.listing&&/^\/(?:sh\/ord|mesh\/ord|mys\/myebay\/purchase)/.test(url.pathname)&&order&&/^[A-Za-z0-9-]{1,100}$/.test(order)?order:null;
 }else if(host==='admin.shopify.com'||/^[a-z0-9-]+\.myshopify\.com$/.test(host)){
  result.provider='shopify';
  const match=host==='admin.shopify.com'?/^\/store\/([a-z0-9-]+)\/orders\/(\d+)\/?$/.exec(url.pathname):/^\/admin\/orders\/(\d+)\/?$/.exec(url.pathname);
  result.storeHandle=host==='admin.shopify.com'?match?.[1]??null:host.split('.')[0];
  result.reference=match?(host==='admin.shopify.com'?match[2]:match[1]):null;
  result.listing=!match;
 }else if(host==='etsy.com'||host==='www.etsy.com'){
  result.provider='etsy';result.listing=/^\/listing\//.test(url.pathname);result.reference=null;
 }else{result.reference=null;}
 if(result.reference&&result.reference.length>200)result.reference=null;
 return result;
}
