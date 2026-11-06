import {z} from 'zod';
export const APP_ORIGIN='packproof-connect://app';
export function trustedRenderer(value:string){try{const u=new URL(value);return u.protocol==='packproof-connect:'&&u.hostname==='app'&&!u.username&&!u.password&&!u.port;}catch{return false;}}
const id=z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const mapping=z.record(z.string().min(1).max(200),z.string().min(1).max(200)).refine(m=>Object.keys(m).length<=50);
export const configuration=z.object({sourceName:z.string().trim().min(1).max(80),integrationAccountId:id.optional(),operatorMembershipId:id.optional(),locationId:id.nullable().optional(),folderDigest:z.string().regex(/^[a-f0-9]{64}$/),mapping,timeZone:z.string().min(1).max(80),importValidRows:z.boolean(),offlineWindowHours:z.number().int().min(0).max(24)}).strict();
export const argumentsByMethod={
 getStatus:z.tuple([]),recoverEnrollment:z.tuple([z.object({preservePendingWorkApproved:z.literal(true)}).strict()]),checkComputer:z.tuple([]),beginEnrollment:z.tuple([]),pollEnrollment:z.tuple([]),chooseFolder:z.tuple([]),previewLocal:z.tuple([z.string().min(1).max(255).refine(x=>!/[\\/:]/.test(x)&&!x.includes('..')&&/\.csv$/i.test(x))]),proposeConfiguration:z.tuple([configuration]),previewCloud:z.tuple([z.object({wholeFileUploadApproved:z.literal(true)}).strict()]),commitBatch:z.tuple([z.object({wholeBatchApproved:z.literal(true)}).strict()]),verifyImport:z.tuple([]),proposeActivation:z.tuple([]),activate:z.tuple([]),pause:z.tuple([]),resume:z.tuple([]),refresh:z.tuple([]),openApproval:z.tuple([]),openRecord:z.tuple([id.optional()]),openPortal:z.tuple([]),exportDiagnostics:z.tuple([])
};
export type Method=keyof typeof argumentsByMethod;
export function approvalUrl(path:string,origin:string){if(path.length>1024||!/^\/app\/(?:records\/connect|connect)(?:[/?]|$)/.test(path)||path.startsWith('//'))throw Error('The approval page was not recognized.');const u=new URL(path,origin);if(u.origin!==new URL(origin).origin||u.protocol!=='https:'||u.username||u.password||u.hash)throw Error('The approval page was not recognized.');for(const k of u.searchParams.keys())if(/secret|token|credential/i.test(k))throw Error('Sensitive approval locator refused.');return u.href;}
export function rendererSafe(value:unknown):unknown{
 if(Array.isArray(value))return value.slice(0,1001).map(rendererSafe);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/token|secret|credential|authorization|polling|redeem/i.test(k)).map(([k,v])=>[k,rendererSafe(v)]));
 if(typeof value==='string')return /\bBearer\s|\bpp_org_(?:sandbox|live)_/.test(value)?'[redacted]':value;
 return value;
}
