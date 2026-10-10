import { z } from 'zod';
export const APP_ORIGIN = 'packproof-app://app';
export function isTrustedRenderer(url: string): boolean {
  try { const u = new URL(url); return u.protocol === 'packproof-app:' && u.hostname === 'app' && !u.username && !u.password && !u.port; } catch { return false; }
}
export function parseDeepLink(value: string, scheme = 'packproof'): string | null {
  if(value.length>2048 || value.includes('%') || value.includes('..')) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== `${scheme}:` || u.username || u.password || u.port || u.search || u.hash) return null;
    if (u.hostname === 'uploads' && (!u.pathname || u.pathname === '/')) return '/uploads';
    if (!['proof','order'].includes(u.hostname) || !/^\/[a-zA-Z0-9_-]{1,128}$/.test(u.pathname)) return null;
    return `/${u.hostname}${u.pathname}`;
  } catch { return null; }
}
export function isAllowedExternal(value:string,webBaseUrl:string):boolean {
  try {const u=new URL(value), web=new URL(webBaseUrl); return value.length<4096 && u.protocol==='https:' && !u.username && !u.password && u.origin===web.origin;}catch{return false;}
}
/** Marketplace authorization is owned by the website's /stores route. */
export function integrationManagementUrl(webBaseUrl:string):string {
  return new URL('/stores',webBaseUrl).href;
}
export const idSchema=z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const previewHash=z.string().regex(/^[a-f0-9]{64}$/);
const email=z.string().trim().email().max(254), password=z.string().min(1).max(1024), code=z.string().trim().min(1).max(128);
export const settingsSchema=z.object({cameraId:z.string().max(512),microphoneId:z.string().max(512),audio:z.boolean(),resolution:z.enum(['720p','1080p']),frameRate:z.union([z.literal(24),z.literal(30)]),retentionHours:z.union([z.literal(0),z.literal(24),z.literal(168)]),notifications:z.boolean(),scannerSuffix:z.enum(['Enter','Tab']),theme:z.enum(['light','dark','system'])}).strict();
export const schemas={
 onboarding:z.tuple([z.object({action:z.enum(['start','step','skip','complete','dismiss_coaching']),version:z.literal(1),step:z.number().int().min(0).max(5).optional()}).strict()]),
 empty:z.tuple([]),report:z.tuple([z.enum(['CAMERA_PERMISSION_DENIED','CAMERA_DISCONNECTED','CAMERA_UNAVAILABLE','RECORDING_FAILED'])]),id:z.tuple([idSchema]),login:z.tuple([z.object({email,password}).strict()]),email:z.tuple([email]),code:z.tuple([z.object({email,code}).strict()]),reset:z.tuple([z.object({email,code,password}).strict()]),
 capture:z.tuple([z.object({proofId:idSchema,label:z.string().max(512),mimeType:z.enum(['video/webm','video/webm;codecs=vp8','video/webm;codecs=vp9','video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/mp4']),camera:z.string().max(256),expectedTracking:z.string().max(256).optional()}).strict()]),
 chunk:z.tuple([idSchema,z.number().int().nonnegative(),z.instanceof(ArrayBuffer).refine(b=>b.byteLength>0 && b.byteLength<=8*1024*1024,'Invalid capture chunk')]),
 finish:z.tuple([idSchema,z.object({attestation:z.boolean(),durationMs:z.number().finite().min(0).max(300_000),startedAt:z.string().datetime().optional(),endedAt:z.string().datetime().optional(),detections:z.array(z.object({rawValue:z.string().min(1).max(1024),format:z.string().max(64),detectedAtMs:z.number().finite().nonnegative().max(3600_000),confirmed:z.boolean().optional(),notThisPackage:z.boolean().optional()}).strict()).max(500)}).strict()]),
 interrupt:z.tuple([idSchema,z.string().max(256)]),settings:z.tuple([settingsSchema.partial()]),url:z.tuple([z.string().url().max(4096)]),resolve:z.tuple([z.string().trim().min(1).max(512)]),evidence:z.tuple([idSchema,idSchema,previewHash.optional()]),
 share:z.tuple([idSchema,z.object({previewHash,originalsReviewed:z.literal(true),expiresAt:z.string().datetime().refine(value=>Date.parse(value)>Date.now()&&Date.parse(value)<=Date.now()+30*86400_000,'Choose a future expiry within 30 days.')}).strict()]),
 transaction:z.tuple([z.object({externalReference:z.string().max(256).nullable().optional(),itemTitle:z.string().min(1).max(512).nullable().optional(),itemDescription:z.string().max(4000).nullable().optional(),quantity:z.number().int().positive().max(100000).nullable().optional(),transactionDate:z.string().max(64).nullable().optional(),transactionValue:z.number().finite().nonnegative().nullable().optional(),currency:z.string().max(10).nullable().optional(),shipping:z.object({carrier:z.string().max(64).nullable().optional(),service:z.string().max(128).nullable().optional(),trackingNumber:z.string().max(256).nullable().optional(),shipmentDate:z.string().max(64).nullable().optional()}).strict().nullable().optional()}).strict()])
};
