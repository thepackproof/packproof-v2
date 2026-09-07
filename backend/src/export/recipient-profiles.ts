import { DomainError } from '../domain/errors.js';
export interface RecipientProfile {id:string;destination:'EBAY_PAYMENT_DISPUTE'|'STRIPE_DISPUTE';disputeType:string;region:'US';network:string;version:string;types:string[];maxBytes:number;exclusiveBytes:boolean;maxFiles:number;maxPages:number;targetBytes:number;requiredFacts:string[];sourceUrls:string[];checkedAt:string;reviewAfter:string;owner:string;acceptance:'PORTAL_VALIDATION_REQUIRED'}
const common={version:'2026-09-07.1',region:'US' as const,checkedAt:'2026-09-07',reviewAfter:'2026-10-07',owner:'PackProof reviewer-export owner',acceptance:'PORTAL_VALIDATION_REQUIRED' as const};
export const RECIPIENT_PROFILES:RecipientProfile[]=[
 {...common,id:'ebay-payment-dispute-us-v1',destination:'EBAY_PAYMENT_DISPUTE',disputeType:'PAYMENT_DISPUTE',network:'ANY',types:['image/jpeg','image/png'],maxBytes:1750000,exclusiveBytes:true,maxFiles:5,maxPages:5,targetBytes:1600000,requiredFacts:['order context','attributed facts','issue-specific stills','material gaps'],sourceUrls:['https://www.ebay.com/help/selling/getting-paid/handling-payment-disputes?id=4799','https://export.ebay.com/en/fees-regulations-policies/seller-protection/handling-payment-disputes/']},
 ...['MASTERCARD','OTHER'].map(network=>({...common,id:`stripe-dispute-us-${network.toLowerCase()}-v1`,destination:'STRIPE_DISPUTE' as const,disputeType:'PAYMENT_DISPUTE',network,types:['application/pdf','image/jpeg','image/png'],maxBytes:4500000,exclusiveBytes:false,maxFiles:1,maxPages:network==='MASTERCARD'?19:19,targetBytes:4000000,requiredFacts:['order context','issue-specific evidence','provider delivery facts or explicit gap','material omissions'],sourceUrls:['https://docs.stripe.com/disputes/best-practices','https://docs.stripe.com/disputes/responding']}))
];
export function recipientProfile(id:unknown,now:Date){const p=RECIPIENT_PROFILES.find(x=>x.id===id);if(!p)throw new DomainError('EXPORT_PROFILE_REVIEW_REQUIRED','This destination, region or card network has no reviewed export profile.',409);if(now.getTime()>=Date.parse(p.reviewAfter))throw new DomainError('EXPORT_PROFILE_STALE','The destination instructions need review before creating another packet.',409);return p;}
export interface EncodedRecipientFile {name:string;contentType:string;bytes:Buffer;pages:number;width?:number;height?:number}
export function validateRecipientFiles(profile:RecipientProfile,files:EncodedRecipientFile[]){
 if(files.length<1||files.length>profile.maxFiles)throw new DomainError('EXPORT_FILE_COUNT_LIMIT','Select fewer relevant files for this destination.',413);
 const count=files.reduce((n,f)=>n+f.pages,0),bytes=files.reduce((n,f)=>n+f.bytes.length,0);
 if(count>profile.maxPages)throw new DomainError('EXPORT_PAGE_LIMIT','The packet exceeds the destination page limit.',413);
 if(profile.exclusiveBytes?bytes>=profile.maxBytes:bytes>profile.maxBytes)throw new DomainError('EXPORT_BYTE_LIMIT','The encoded packet exceeds the destination total size limit.',413);
 for(const f of files){
  const magic=f.contentType==='application/pdf'?f.bytes.subarray(0,5).toString()==='%PDF-':f.contentType==='image/png'?f.bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):f.contentType==='image/jpeg'?f.bytes[0]===255&&f.bytes[1]===216&&f.bytes.at(-2)===255&&f.bytes.at(-1)===217:false;
  if(!profile.types.includes(f.contentType)||!magic||!Number.isSafeInteger(f.pages)||f.pages<1)throw new DomainError('EXPORT_FILE_INVALID','The generated file does not match its declared format.',409);
  if(f.contentType!=='application/pdf'&&(!f.width||!f.height||Math.min(f.width,f.height)<600))throw new DomainError('EXPORT_LEGIBILITY_REVIEW','Select evidence that can fit at a readable size.',409);
 }
 return {bytes,pages:count,files:files.length};
}
