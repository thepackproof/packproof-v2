import {afterEach,expect,it,vi} from 'vitest';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer,request as makeRequest} from 'node:http';
import {copyFile,mkdir,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {BearerUserAdapter} from '../src/auth/adapter.js';
import {createServerApp} from '../src/server-app.js';
import {DisabledEmailDelivery} from '../src/integrations/email/delivery.js';
import {LocalObjectStore} from '../src/s3/local-object-store.js';
import {createOrganization,setOrganizationEntitlement} from '../src/platform/organizations.js';

afterEach(()=>vi.unstubAllEnvs());

it.skipIf(process.env.PACKPROOF_JOURNEY_REAL_HTTP!=='1' || process.platform!=='win32')('drives the Windows collector, scoped operator HTTP approval, order view and exported revisions together',async()=>{
  const repo=path.resolve('..'),fixture=path.join(repo,'examples/multisource-journey/fixtures');
  const root=await mkdtemp(path.join(tmpdir(),'pp-controlled-http-'));
  const pipeName='packproof-journey-'+randomUUID();
  const socketPath='\\\\.\\pipe\\'+pipeName;
  const clock={now:()=>new Date()};
  for(const flag of ['ORGANIZATIONS','SOURCE_SUBSCRIPTIONS','MULTI_SOURCE_AGENT','TYPED_INTAKE','ORDER_WORKSPACE','CASE_RECONSTRUCTION','SOURCE_IDENTITY_V2']) vi.stubEnv('PACKPROOF_'+flag+'_ENABLED','true');
  vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));
  // The reference operation may never use a configured external database.
  vi.stubEnv('PACKPROOF_TEST_DATABASE_URL','');
  const db=await openIsolatedTestDatabase();
  const app=createServerApp({db:db.db,clock,objectStore:new LocalObjectStore(path.join(root,'objects'),'http://localhost','isolated-fixture'),
    auth:new BearerUserAdapter(db.db),devAuth:true,testFixtures:true,publicBaseUrl:'https://api.example.test',corsOrigins:['https://portal.example.test'],
    webhookConfig:{encryptionKey:randomBytes(32).toString('base64'),allowedHosts:['example.test']},emailDelivery:new DisabledEmailDelivery()});
  const server=createServer(app);
  const routes:Record<string,number>={};
  server.on('request',(req,res)=>{res.on('finish',()=>{
    const route=(req.method||'')+' '+(req.url||'').split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/ig,':id')+' '+res.statusCode;
    routes[route]=(routes[route]||0)+1;
  });});
  const call=(method:string,url:string,body?:unknown,headers:Record<string,string>={})=>new Promise<any>((accept,reject)=>{
    const request=makeRequest({socketPath,method,path:url,headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})}},response=>{
      const chunks:Buffer[]=[];
      response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);response.on('end',()=>{
        try {const json=JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if((response.statusCode||500)>=400)throw Error(method+' '+url.split('?')[0]+' '+response.statusCode+' '+(json.error?.code||json.code||''));
          accept(json);
        } catch(e){reject(e);}
      });
    });
    request.setTimeout(12000,()=>request.destroy(Error('Local HTTP request timed out')));
    request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));
  });
  let runner:ChildProcess|undefined, exited:number|null|undefined,phase='initialize';
  const poll=async<T>(description:string,read:()=>Promise<T|undefined>,max=45000):Promise<T>=>{
    phase=description;
    const deadline=Date.now()+max;
    while(Date.now()<deadline) {
      const value=await read(); if(value!==undefined)return value;
      if(exited!==undefined)throw Error('Native driver exited '+exited+' during '+description);
      await wait(250);
    }
    throw Error('Timed out during '+description);
  };
  const receipt=(file:string)=>readFile(path.join(root,file),'utf8').then(text=>JSON.parse(text)).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT'||e instanceof SyntaxError)return undefined;throw e;});
  const publish=async(folder:string,file:string,name=file)=>{const target=path.join(root,folder,name);await copyFile(path.join(fixture,file),target+'.tmp');await rename(target+'.tmp',target);};
  const timings:Record<string,string>={};const mark=(s:string)=>{timings[s]=new Date().toISOString();};
  try {
    await migrate(db.db);
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
    const admin=await insertUser(db.db,clock),owner=await insertUser(db.db,clock);
    await db.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
    const org=(await createOrganization(db.db,clock,admin,{kind:'MERCHANT',name:'Disposable multi-source operation',ownerUserId:owner},'fixture')).id;
    await setOrganizationEntitlement(db.db,clock,admin,org,{enabled:true},'fixture');
    const member=(await db.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[org,owner])).rows[0].id;
    const adminHeaders={Authorization:'Bearer '+owner};
    const scope={organizationId:org,environment:'sandbox'};
    const query='?'+new URLSearchParams(scope);
    const e=await call('POST','/connect/enrollments',{deviceName:'Controlled Windows collector',version:'0.5.0'});
    const enrolled=await call('POST','/me/records/agent-enrollments/'+e.id+'/decision'+query,{...scope,decision:'approve',comparisonCode:e.comparisonCode,operatorMembershipId:member,locationId:null,sourceName:'Controlled source files',integrationAccountId:null,createLocalSource:true},{...adminHeaders,'Idempotency-Key':'journey-enrollment'});
    const grant=await call('POST','/connect/enrollments/'+e.id+'/redeem',{redeemSecret:e.redeemSecret});
    const credentials={Authorization:'Bearer '+grant.token,'PackProof-Merchant-Id':org};
    await call('POST','/v1/partner/agent/heartbeat',{version:'0.5.0',queueCount:0,enrollmentAcknowledged:true},credentials);
    for(const folder of ['order','picking','packing','shipping','handoff','delivery','output']) await mkdir(path.join(root,folder));
    const ps=process.env.PACKPROOF_JOURNEY_NATIVE_PS;
    runner=spawn(ps?'pwsh':'dotnet',ps?['-NoProfile','-NonInteractive','-File',ps]:['test','service-tests/PackProof.Connect.Service.Tests.csproj','-c','Release','--no-build','--filter','FullyQualifiedName~Run_real_order_service_against_isolated_http_application'],
      {cwd:path.join(repo,'connect-windows'),windowsHide:true,stdio:['ignore','inherit','inherit'],env:{...process.env,PACKPROOF_JOURNEY_ROOT:root,
        PACKPROOF_JOURNEY_API:'http://localhost',PACKPROOF_JOURNEY_PIPE:pipeName,PACKPROOF_JOURNEY_TOKEN:grant.token,PACKPROOF_JOURNEY_INSTALLATION:enrolled.installationId}});
    runner.on('exit',code=>{exited=code;});runner.on('error',err=>{console.error(err.message);exited=-1;});
    const session=await poll('native draft and authorization proposal',()=>receipt('scope.json'));
    const resource='/me/records/agent-installations/'+enrolled.installationId+'/order-workspace/'+session.sessionId;
    const pending=await call('GET',resource+query,undefined,adminHeaders);
    expect(pending.scopeDigest).toBe(session.scopeDigest);
    const approved=await call('POST',resource+'/decision'+query,{...scope,scopeDigest:pending.scopeDigest,decision:'approve'},adminHeaders);
    expect(approved.state).toBe('active'); mark('authorized');
    const list=()=>call('GET','/me/records/order-proofs'+query,undefined,adminHeaders);
    const view=(id:string)=>call('GET','/me/records/order-proofs/'+id+query,undefined,adminHeaders);
    await publish('order','orders.json');mark('orderPublished');
    const first=await poll('earliest order capture',async()=>(await list()).orders?.find((o:any)=>o.orderReference==='SO10482'));
    const firstDoc=await view(first.proofId); expect(firstDoc.revision).toBe(1);mark('initialOnline');
    await publish('picking','picking.csv');await publish('packing','packages.xml');await publish('shipping','labels.json');
    const labelled=await poll('qualified label records',async()=>{const v=await view(first.proofId);return v.events.filter((x:any)=>x.kind==='label').length===2?v:undefined;});
    expect(labelled.events.some((x:any)=>x.kind==='handoff')).toBe(false);
    await publish('handoff','handoff.json');await publish('delivery','delivery.jsonl');
    await poll('delivery and split allocations',async()=>{const v=await view(first.proofId);return v.events.filter((x:any)=>x.kind==='delivery').length===2&&v.lines.find((l:any)=>l.lineId==='20')?.shippedQuantity==='2'?v:undefined;});
    await writeFile(path.join(root,'restart'),'');await poll('protected worker restart',()=>receipt('restarted.json'));
    await publish('order','corrections.json','orders.json');mark('correctionPublished');
    const final=await poll('same proof receives quantity correction',async()=>{const v=await view(first.proofId);return v.lines.find((l:any)=>l.lineId==='20')?.orderedQuantity==='3'?v:undefined;});
    expect(final.lines.find((l:any)=>l.lineId==='20').shippedQuantity).toBe('2');mark('correctedOnline');
    const serviceView=await call('GET','/v1/partner/agent/order-proofs/'+first.proofId+'/revisions/'+final.revision,undefined,credentials);
    expect(serviceView).toEqual(final);
    const verifier=await import('../../examples/multisource-journey/verify-output.mjs');
    const checked=await poll('latest published output bundle',async()=>{try{return await verifier.verifyOutput(path.join(root,'output'),final);}catch{return undefined;}});
    mark('outputVerified');
    const status=await poll('desktop service projection of committed order',async()=>{const s=await receipt('service-status.json');return s?.workspace?.orders?.some((o:any)=>o.proofId===first.proofId&&o.revision===final.revision)?s:undefined;});
    const msg={scope:'isolated application; real HTTP over Windows pipe, C# command runtime and filesystem, browser authorization endpoint, database, immutable originals, service dashboard feed and local writer',
      proofId:first.proofId,earliestRevision:firstDoc.revision,latestRevision:final.revision,verifiedFiles:checked.filesVerified,
      activeSources:status.workspace.sources.length,timings,onlineAfterCorrectionMs:Date.parse(timings.correctedOnline)-Date.parse(timings.correctionPublished),
      localAfterCommitObservedMs:Date.parse(timings.outputVerified)-Date.parse(timings.correctedOnline),routes};
    if(process.env.PACKPROOF_JOURNEY_RESULT)await writeFile(process.env.PACKPROOF_JOURNEY_RESULT,JSON.stringify(msg,null,2));
    console.log('Real HTTP journey',JSON.stringify({earliest:firstDoc.revision,latest:final.revision,verifiedFiles:checked.filesVerified,timings}));
  } catch(error) {
    const s=await receipt('service-status.json');
    console.error('Journey checkpoint',phase,JSON.stringify({routes,error:s?.error?.code,attention:s?.workspace?.attention,
      sources:s?.workspace?.sources?.map((v:any)=>({state:v.state,issue:v.issue,queued:v.queued}))}));
    throw error;
  } finally {
    if(runner && exited===undefined) {
      await writeFile(path.join(root,'done'),'');
      for(let i=0;i<24 && exited===undefined;i++)await wait(250);
      if(exited===undefined)runner.kill();
    }
    server.closeAllConnections();
    await new Promise<void>(r=>server.close(()=>r()));
    await db.close();
    await rm(root,{recursive:true,force:true,maxRetries:5});
  }
},240000);
