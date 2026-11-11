import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyHostedApproval } from '../scripts/verify-hosted-approval.mjs';
const web='https://web.example', api='https://api.example';
const html='<!doctype html><div id="root"></div>';
const release={commit:'a'.repeat(40),indexSha256:createHash('sha256').update(html).digest('hex'),apiUrl:api,approvalPath:'/app/records/connect/approve',capabilities:{connectApproval:1}};
const responder=(manifest=release,page=html) => async (url, options) => {
  assert.equal(options.redirect,'error');
  return url.endsWith('/release.json') ? new Response(JSON.stringify(manifest),{headers:{'content-type':'application/json'}}) : new Response(page,{headers:{'content-type':'text/html'}});
};
test('accepts only the source-pinned approval application for the configured API',async()=>{
 assert.deepEqual(await verifyHostedApproval(web,api,responder()),{webOrigin:web,apiOrigin:api,webCommit:release.commit,approvalPath:release.approvalPath});
});
test('refuses a normal website without the approval release capability',async()=>{
 await assert.rejects(verifyHostedApproval(web,api,responder({...release,capabilities:{}})),/compatible/);
});
test('refuses a release connected to another API',async()=>{
 await assert.rejects(verifyHostedApproval(web,api,responder({...release,apiUrl:'https://other.example'})),/compatible/);
});
test('refuses a stale or unrelated page at the approval URL',async()=>{
 await assert.rejects(verifyHostedApproval(web,api,responder(release,'normal login redirect page')),/does not serve/);
});
test('refuses a silently redirected approval response',async()=>{
 const fn=async(url,options)=>{const r=await responder()(url,options);if(!url.endsWith('/release.json'))Object.defineProperty(r,'url',{value:web+'/login'});return r;};
 await assert.rejects(verifyHostedApproval(web,api,fn),/failed/);
});
test('refuses insecure origins and embedded credentials',async()=>{
 for(const url of ['http://web.example','https://u:p@web.example','https://web.example/path'])await assert.rejects(verifyHostedApproval(url,api,responder()),/HTTPS origin/);
});
