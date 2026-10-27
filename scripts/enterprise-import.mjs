#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename,extname } from 'node:path';
import { createHash } from 'node:crypto';
const values=new Map(),docs=[];let commit=false;
for(let i=2;i<process.argv.length;i++){const a=process.argv[i];if(a==='--commit'){commit=true;continue;}if(!a.startsWith('--')||!process.argv[i+1]||process.argv[i+1].startsWith('--'))throw Error('Use --api URL --source ID --mapping VERSION --input FILE --mode synthetic|historical [--document FILE] [--commit]');const v=process.argv[++i];if(a==='--document')docs.push(v);else values.set(a,v);}
const required=k=>{const v=values.get(k);if(!v)throw Error('Missing '+k);return v;};
const api=new URL(required('--api'));
if(api.username||api.password||api.search||api.hash||!(['https:'].includes(api.protocol)||api.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(api.hostname)))throw Error('Use an approved HTTPS PackProof API, or local development loopback.');
const mode=required('--mode');if(!['synthetic','historical'].includes(mode))throw Error('Explicit data designation is required.');
const token=process.env.PACKPROOF_ENTERPRISE_TOKEN;if(!token)throw Error('Set PACKPROOF_ENTERPRISE_TOKEN securely. It is never printed.');
const filename=required('--input'),sourceId=required('--source'),mappingVersion=required('--mapping'),content=await readFile(filename),format=(values.get('--format')??extname(filename).slice(1)).toUpperCase();
if(!['CSV','JSON'].includes(format))throw Error('Choose a CSV or JSON original.');
const files=[];for(const file of docs){const ext=extname(file).toLowerCase(),contentType={'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'}[ext];if(!contentType)throw Error('Attachments must be PDF, PNG or JPEG originals.');const bytes=await readFile(file);files.push({documentKey:basename(file),contentType,base64:bytes.toString('base64'),size:bytes.length});}
if(docs.length>20||content.length+files.reduce((n,f)=>n+f.size,0)>1048576)throw Error('Split the export into pilot batches: at most 20 documents and 1 MiB decoded bytes.');
const body={schemaVersion:'packproof.enterprise.import/v1',sourceId,mappingVersion,format,synthetic:mode==='synthetic',contentBase64:content.toString('base64'),files:files.map(({size,...f})=>f)};
const headers={'Content-Type':'application/json',Authorization:'Bearer '+token};
async function send(path,payload,idempotencyKey){
 const response=await fetch(api.href.replace(/\/$/,'')+'/v1/enterprise'+path,{method:'POST',headers:{...headers,...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(120000)});
 let result;try{result=await response.json();}catch{throw Error('PackProof returned an unreadable response; do not change a committed request before retrying.');}
 if(!response.ok)throw Error('PackProof '+response.status+': '+(result.error?.code??'REQUEST_FAILED')+' '+(result.error?.message??''));return result;
}
const preview=await send('/imports/preview',body);
process.stdout.write(JSON.stringify({mode,phase:'PREVIEW',counts:preview.counts,warnings:preview.warnings},null,2)+'\n');
if(commit){
 const payload={...body,previewDigest:preview.previewDigest},stableKey=values.get('--idempotency-key')??'enterprise-cli-'+createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 const result=await send('/imports',payload,stableKey);
 process.stdout.write(JSON.stringify({phase:'COMMITTED',batchId:result.id,counts:result.counts,manifestSha256:result.manifestSha256},null,2)+'\n');
}else process.stdout.write('Preview only. Use --commit after reviewing the approved source contract and row diagnostics.\n');
