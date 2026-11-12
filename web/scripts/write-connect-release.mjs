import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../dist/',import.meta.url));
const commit=process.env.PACKPROOF_WEB_RELEASE_COMMIT;
const api=new URL(process.env.VITE_PACKPROOF_API_BASE_URL || '');
if(!/^[a-f0-9]{40}$/.test(commit || '') || api.protocol!=='https:' || api.pathname!=='/' || api.search || api.hash || api.username || api.password)throw Error('Require an exact source commit and HTTPS API origin.');
async function files(dir,base=''){
 const entries=await readdir(dir,{withFileTypes:true});let out=[];
 for(const entry of entries){const name=base+entry.name;if(entry.isDirectory())out.push(...await files(path.join(dir,entry.name),name+'/'));else if(entry.isFile()&&name!=='release.json'){const bytes=await readFile(path.join(dir,entry.name));out.push({path:name,sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length});}}
 return out.sort((a,b)=>a.path.localeCompare(b.path));
}
const assets=await files(root);const index=assets.find(x=>x.path==='index.html');
const scripts=await Promise.all(assets.filter(x=>x.path.endsWith('.js')).map(x=>readFile(path.join(root,x.path),'utf8')));
if(!index || !scripts.some(x=>x.includes('packproof.connect.approval-return.v1')) || !scripts.some(x=>x.includes('Review this collection computer')))throw Error('The built application lacks the Connect authorization flow.');
const release={schema:'packproof.web-release/v1',commit,environment:'production',apiUrl:api.origin,indexSha256:index.sha256,approvalPath:'/app/records/connect/approve',capabilities:{connectApproval:1},assets};
await writeFile(path.join(root,'release.json'),JSON.stringify(release,null,2)+'\n');
console.log(JSON.stringify({webReleasePrepared:true,commit,indexSha256:index.sha256,files:assets.length,apiUrl:api.origin}));
