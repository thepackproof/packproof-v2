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
 assert.deepEqual(await verifyHostedApproval(web,api,responder()),{webOrigin:web,apiOrigin:api,webCommit:release.commit,approvalPath:release.approvalPath,supportsOrderWorkspace:false});
});
test('signed channels require exact hosted support for the multi-source approval locator',async()=>{
 await assert.rejects(verifyHostedApproval(web,api,responder(),{requireOrderWorkspace:true}),/multi-source approval/);
 const paths=[];
 const serve=responder({...release,capabilities:{connectApproval:1,orderWorkspaceApproval:1}});
 const result=await verifyHostedApproval(web,api,async(...args)=>{paths.push(args[0]);return serve(...args);},{requireOrderWorkspace:true});
 assert.equal(result.supportsOrderWorkspace,true);
 assert.ok(paths.some(value=>value.includes('workspaceSession=release-check')));
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

test('matches the reviewed hosted portal commit before signing or publishing', async () => {
  await verifyHostedApproval(web, api, responder(), {expectedCommit:release.commit});
  await assert.rejects(verifyHostedApproval(web, api, responder(), {expectedCommit:'b'.repeat(40)}), /reviewed portal commit/);
});

test('production checks use Cognito and the live approval locator on the reviewed release', async () => {
  const manifest={...release,environment:'production',auth:{mode:'cognito'},capabilities:{connectApproval:1,orderWorkspaceApproval:1}};
  const serve=responder(manifest), paths=[];
  function serveApi(commit) {
    return async (...args) => {
      paths.push(args[0]);
      if (args[0] === api + '/meta') return new Response(JSON.stringify({commit}),{headers:{'content-type':'application/json'}});
      return serve(...args);
    };
  }
  const requested={expectedCommit:release.commit,expectedEnvironment:'production',requireOrderWorkspace:true};
  await verifyHostedApproval(web,api,serveApi(release.commit),requested);
  await assert.rejects(verifyHostedApproval(web,api,serveApi('f'.repeat(40)),requested), /API does not match/);
  assert.ok(paths.some(p=>p.includes('environment=live')));
  for (const overrides of [{environment:'staging'},{auth:{mode:'fixture'}}]) {
    await assert.rejects(verifyHostedApproval(web,api,responder({...manifest,...overrides}),{expectedEnvironment:'production'}),/environment and Cognito/);
  }
});
