// Private control plane for the disposable Windows installation rehearsal.
// The installed LocalService makes its own TLS requests to the real application.
import {createServer} from 'node:https';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import request from 'supertest';
import {createHarness,createUser,auth} from './helpers.js';
import {createOrganization,setOrganizationEntitlement} from '../src/platform/organizations.js';

const root=process.argv[2];
if(process.env.GITHUB_ACTIONS!=='true' || process.env.APP_ENV!=='development' || !path.isAbsolute(root) || process.platform!=='win32')
  throw Error('The installation fixture requires a disposable development Windows CI machine.');
process.env.PACKPROOF_ORGANIZATIONS_ENABLED='true';
process.env.PACKPROOF_ORDER_WORKSPACE_ENABLED='true';
process.env.PACKPROOF_GUIDED_FACILITIES='';
process.env.PACKPROOF_WEBHOOK_ENCRYPTION_KEY=randomBytes(32).toString('base64');
process.env.PACKPROOF_EVENT_CURSOR_KEY=randomBytes(32).toString('base64');
const h=await createHarness();
const tls=createServer({pfx:await readFile(path.join(root,'loopback.pfx')),passphrase:'disposable'},h.app);
async function signal(name:string,value:unknown) {
  const target=path.join(root,name+'.json');
  await writeFile(target+'.tmp',JSON.stringify(value));
  await rename(target+'.tmp',target);
}
try {
  const operator=await createUser(h),owner=await createUser(h),now=h.clock.now().toISOString();
  await h.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[operator,now]);
  const org=(await createOrganization(h.db,h.clock,operator,{kind:'MERCHANT',name:'Disposable installed upgrade',ownerUserId:owner},'fixture')).id;
  await setOrganizationEntitlement(h.db,h.clock,operator,org,{enabled:true},'fixture');
  const member=(await h.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[org,owner])).rows[0].id;
  await h.db.query("INSERT INTO record_locations VALUES('upgrade',$1,'Upgrade rehearsal',$2)",[org,now]);
  const scope={organizationId:org,environment:'sandbox'};
  const api=request(h.app);
  await new Promise<void>((resolve,reject)=>{tls.once('error',reject);tls.listen(0,'127.0.0.1',resolve);});
  const addr=tls.address();
  if(!addr || typeof addr==='string') throw Error('Loopback listener did not start.');
  await signal('ready',{origin:'https://127.0.0.1:'+addr.port});
  let installationId:string|undefined;
  for(let sequence=1;;sequence++) {
    const input=path.join(root,sequence+'.request.json');
    let contents:string;
    for(;;) {
      try {contents=await readFile(input,'utf8');break;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;await wait(100);}
    }
    const body=JSON.parse(contents);
    if(body.command==='stop') break;
    if(body.command==='enroll' && !installationId) {
      const response=await api.post('/me/records/agent-enrollments/'+encodeURIComponent(body.id)+'/decision').set(auth(owner))
        .set('Idempotency-Key','approve-installed-upgrade').send({...scope,decision:'approve',comparisonCode:body.code,
          operatorMembershipId:member,locationId:'upgrade',sourceName:'Installed upgrade source',integrationAccountId:null,createLocalSource:true});
      if(response.status!==200 && response.status!==201) throw Error('Enrollment review failed: '+response.status);
      installationId=response.body.installationId;
      await signal(sequence+'.result',{installationId});
    } else if(body.command==='approveSources' && installationId) {
      const url='/me/records/agent-installations/'+encodeURIComponent(installationId)+'/order-workspace/'+encodeURIComponent(body.id);
      const review=await api.get(url).set(auth(owner)).query(scope);
      if(review.status!==200 || review.body.state!=='pending' || review.body.scope.sources.length!==1 ||
        review.body.scope.sources[0].id!==body.source || review.body.scope.sources[0].generation!==1) throw Error('Unexpected source scope.');
      const reply=await api.post(url+'/decision').set(auth(owner)).send({...scope,decision:'approve',scopeDigest:review.body.scopeDigest});
      if(reply.status!==200 || reply.body.state!=='active') throw Error('Source approval failed.');
      await signal(sequence+'.result',{scopeDigest:review.body.scopeDigest});
    } else if(body.command==='pilotOn' || body.command==='pilotOff') {
      process.env.PACKPROOF_GUIDED_FACILITIES=body.command==='pilotOn'?org+':sandbox:upgrade':'';
      await signal(sequence+'.result',{updated:true});
    } else throw Error('Unsupported fixture step.');
  }
} finally {
  tls.closeAllConnections();
  if(tls.listening) await new Promise<void>(resolve=>tls.close(()=>resolve()));
  await h.close();
}
