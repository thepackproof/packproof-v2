import {afterEach,expect,it,vi} from 'vitest';
import {AsyncLocalStorage} from 'node:async_hooks';
import {spawn,type ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer,request as makeRequest} from 'node:http';
import {copyFile,mkdir,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {measureOrderLatency} from './order-journey-benchmark.js';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {BearerUserAdapter} from '../src/auth/adapter.js';
import {createServerApp} from '../src/server-app.js';
import {DisabledEmailDelivery} from '../src/integrations/email/delivery.js';
import {LocalObjectStore} from '../src/s3/local-object-store.js';
import {createOrganization,setOrganizationEntitlement,createServicePrincipal,issuePartnerCredential} from '../src/platform/organizations.js';

afterEach(()=>vi.unstubAllEnvs());

it.skipIf(process.env.PACKPROOF_JOURNEY_REAL_HTTP!=='1' || process.platform!=='win32')('drives the Windows collector, scoped operator HTTP approval, order view and exported revisions together',async()=>{
  const repo=path.resolve('..'),fixture=path.join(repo,'examples/multisource-journey/fixtures');
  const reference=process.env.PACKPROOF_JOURNEY_CARTONS==='1';
  const referenceRoot=path.join(repo,'examples/multisource-journey/reference');
  const expected=reference?JSON.parse(await readFile(path.join(referenceRoot,'expectations.json'),'utf8')):null;
  const root=await mkdtemp(path.join(tmpdir(),'pp-controlled-http-'));
  const pipeName='packproof-journey-'+randomUUID();
  const socketPath='\\\\.\\pipe\\'+pipeName;
  const observationClock=new AsyncLocalStorage<string>();
  let dispatchTime:string|undefined=expected?.clock.lastDispatchRead;
  const clock={now:()=>{const time=observationClock.getStore();return time?new Date(time):new Date();}};
  for(const flag of ['ORGANIZATIONS','ORDER_WORKSPACE']) vi.stubEnv('PACKPROOF_'+flag+'_ENABLED','true');
  vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));
  // The reference operation may never use a configured external database.
  vi.stubEnv('PACKPROOF_TEST_DATABASE_URL','');
  const db=await openIsolatedTestDatabase();
  const app=createServerApp({db:db.db,clock,objectStore:new LocalObjectStore(path.join(root,'objects'),'http://localhost','isolated-fixture'),
    auth:new BearerUserAdapter(db.db),devAuth:true,testFixtures:true,publicBaseUrl:'https://api.example.test',corsOrigins:['https://portal.example.test'],
    webhookConfig:{encryptionKey:randomBytes(32).toString('base64'),allowedHosts:['example.test']},emailDelivery:new DisabledEmailDelivery()});
  const server=createServer((req,res)=>{
    if(dispatchTime && /\/order-workspace\/(observations|source-health)$|\/order-source-health\b/.test(req.url||''))
      observationClock.run(dispatchTime,()=>app(req,res));
    else app(req,res);
  });
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
    const locationId=reference?'reference-facility':null;
    if(locationId) {
      await db.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[locationId,org,'Reference facility',clock.now().toISOString()]);
      vi.stubEnv('PACKPROOF_GUIDED_FACILITIES',[org,'sandbox',locationId].join(':'));
    }
    const e=await call('POST','/connect/enrollments',{deviceName:'Controlled Windows collector',version:'0.7.0'});
    const enrolled=await call('POST','/me/records/agent-enrollments/'+e.id+'/decision'+query,{...scope,decision:'approve',comparisonCode:e.comparisonCode,operatorMembershipId:member,locationId,sourceName:'Controlled source files',integrationAccountId:null,createLocalSource:true},{...adminHeaders,'Idempotency-Key':'journey-enrollment'});
    const grant=await call('POST','/connect/enrollments/'+e.id+'/redeem',{redeemSecret:e.redeemSecret});
    const credentials={Authorization:'Bearer '+grant.token,'PackProof-Merchant-Id':org};
    await call('POST','/v1/partner/agent/heartbeat',{version:'0.7.0',queueCount:0,enrollmentAcknowledged:true},credentials);
    const account=(await db.db.query<{id:string}>('SELECT integration_account_id AS id FROM record_agent_installations WHERE id=$1',[enrolled.installationId])).rows[0].id;
    const sender=await createServicePrincipal(db.db,clock,owner,org,{name:'Fixture ERP'},'fixture');
    const credential=await issuePartnerCredential(db.db,clock,owner,org,sender.id,{scopes:['proofs:write','proofs:read'],expiresAt:new Date(Date.now()+86400000).toISOString()},'fixture');
    const merchant={'Authorization':'Bearer '+credential.token,'PackProof-Merchant-Id':org};
    const partnerOrder={integrationAccountId:account,operatorMembershipId:member,externalId:'API-BEFORE',transaction:{itemTitle:'Existing direct order',quantity:2}};
    const earlier=await call('POST','/v1/partner/proofs',partnerOrder,{...merchant,'Idempotency-Key':'before-approval'});
    for(const folder of ['order','picking','packing','evidence','shipping','handoff','delivery','output']) await mkdir(path.join(root,folder));
    const referenceFile=async(folder:string,file:string,name=file)=>{
      const destination=path.join(root,folder,name);
      await copyFile(path.join(referenceRoot,file),destination+'.tmp');
      await rename(destination+'.tmp',destination);
    };
    if(reference) {
      await copyFile(path.join(referenceRoot,'expectations.json'),path.join(root,'expectations.json'));
      for(const [folder,file] of [['order','orders.csv'],['packing','cartons.csv'],['shipping','labels.csv'],['delivery','dispatch-initial.csv']])
        await referenceFile(folder,file);
    }
    const ps=process.env.PACKPROOF_JOURNEY_NATIVE_PS;
    runner=spawn(ps?'pwsh':'dotnet',ps?['-NoProfile','-NonInteractive','-File',ps]:['test','service-tests/PackProof.Connect.Service.Tests.csproj','-c','Release','--no-build','--filter','FullyQualifiedName~Run_real_order_service_against_isolated_http_application'],
      {cwd:path.join(repo,'connect-windows'),windowsHide:true,stdio:['ignore','inherit','inherit'],env:{...process.env,PACKPROOF_JOURNEY_ROOT:root,
        PACKPROOF_JOURNEY_API:'http://localhost',PACKPROOF_JOURNEY_PIPE:pipeName,PACKPROOF_JOURNEY_TOKEN:grant.token,PACKPROOF_JOURNEY_INSTALLATION:enrolled.installationId}});
    runner.on('exit',code=>{exited=code;});runner.on('error',err=>{console.error(err.message);exited=-1;});
    const session=await poll('native draft and authorization proposal',()=>receipt('scope.json'));
    const resource='/me/records/agent-installations/'+enrolled.installationId+'/order-workspace/'+session.sessionId;
    const pending=await call('GET',resource+query,undefined,adminHeaders);
    expect(pending.scopeDigest).toBe(session.scopeDigest);
    const useBrowser=process.env.PACKPROOF_JOURNEY_BROWSER==='1';
    async function checkInBrowser(proof?: {id:string;revision:number;carton?:string;historicalRevision?:number;locationId?:string|null}) {
      const desktop=path.join(repo,'connect-windows');
      const phase=proof?'order':'consent';
      const locator=path.join(root,'browser-'+phase+'.json');
      await writeFile(locator,JSON.stringify({pipe:pipeName,owner,approvalPath:pending.approvalPath,proof}),{flag:'wx'});
      const executable=process.env.PACKPROOF_JOURNEY_BROWSER_EXE || createRequire(path.join(desktop,'package.json'))('electron') as string;
      const browser=spawn(executable,['--disable-gpu','--user-data-dir='+path.join(root,'browser-profile-'+phase),path.join(desktop,'scripts/browser-order-approval.cjs')],{
        cwd:desktop,windowsHide:true,stdio:['ignore','inherit','inherit'],timeout:60000,env:{...process.env,PACKPROOF_BROWSER_FIXTURE:locator}
      });
      await new Promise<void>((resolve,reject)=>{
        browser.once('error',reject);
        browser.once('exit',code=>code===0?resolve():reject(Error('Browser consent check exited '+code)));
      });
    }
    if(useBrowser) {
      await db.db.query("UPDATE users SET username='fixture-owner',display_name='Fixture owner' WHERE id=$1",[owner]);
      await checkInBrowser();
    } else await call('POST',resource+'/decision'+query,{...scope,scopeDigest:pending.scopeDigest,decision:'approve'},adminHeaders);
    const approved=await call('GET',resource+query,undefined,adminHeaders);
    expect(approved.state).toBe('active'); mark('authorized');
    const list=()=>call('GET','/me/records/order-proofs'+query,undefined,adminHeaders);
    const view=(id:string)=>call('GET','/me/records/order-proofs/'+id+query,undefined,adminHeaders);
    if(reference) {
      await referenceFile('delivery','POD-7784.pdf');
      const lookup=()=>call('GET','/me/records/order-proofs'+query+'&q=CTN-02&referenceType=package',undefined,adminHeaders);
      const pinned=await poll('initial split order, label and carton 01 original',async()=>{
        const card=(await lookup()).orders[0]; if(!card)return;
        const proof=await view(card.proofId);
        return proof.events.some((e:any)=>e.eventId==='LABEL-482') && proof.originalArtifacts.some((a:any)=>a.fileName==='POD-7784.pdf')?proof:undefined;
      });
      const deliveries=(proof:any)=>proof.events.filter((e:any)=>e.kind==='delivery').flatMap((e:any)=>e.references.filter((r:any)=>r.type==='package').map((r:any)=>r.id)).sort();
      expect(deliveries(pinned)).toEqual(expected.split.deliveredBefore);
      expect(pinned.events.find((e:any)=>e.eventId==='LABEL-482')).toMatchObject({kind:'label'});
      expect(pinned.events.some((e:any)=>e.kind==='handoff')).toBe(false);
      const verify=await import('../../examples/multisource-journey/verify-output.mjs');
      const output=path.join(root,'output');
      const packet=await poll('initial pinned packet',()=>verify.verifyOutput(output,pinned).catch(()=>undefined));
      const originalPacket=path.join(output,packet.directory,'revision-'+String(pinned.revision).padStart(8,'0'),'record.json');
      const previousPacket=await readFile(originalPacket);
      const source=session.sources.find((s:any)=>s.role==='delivery').id;
      const held=path.join(root,'dispatch-disconnected');
      await rename(path.join(root,'delivery'),held);
      dispatchTime=expected.clock.inspect;
      await writeFile(path.join(root,'inspect-outage'),'');
      await poll('service detects dispatch read failure',async()=>{
        const status=await receipt('service-status.json'); return status?.workspace.sources.find((s:any)=>s.id===source && s.issue && s.coverageGap);
      });
      const health=()=>call('GET','/me/records/order-source-health'+query+'&locationId='+locationId,undefined,adminHeaders);
      const delayed=await poll('one source incident for the missed dispatch check',async()=>{
        const results=(await health()).incidents.filter((i:any)=>i.sourceId===source);
        return results.length===1?results[0]:undefined;
      });
      expect(new Date(delayed.lastVerifiedReadAt).toISOString()).toBe(new Date(expected.clock.lastDispatchRead).toISOString());
      expect(new Date(delayed.nextCheckAt).toISOString()).toBe(new Date(expected.clock.nextExpectedCheck).toISOString());
      expect(delayed.affectedOrders.some((o:any)=>o.proofId===pinned.proofId)).toBe(true);
      expect((await health()).overdue.some((o:any)=>o.proofId===pinned.proofId && o.id==='CTN-02')).toBe(false);
      await referenceFile('packing','packing-progress.csv');
      await poll('healthy packing source advances another order during dispatch outage',async()=>{
        const card=(await call('GET','/me/records/order-proofs'+query+'&q=CTN-03&referenceType=package',undefined,adminHeaders)).orders[0];
        if(!card)return;
        return (await view(card.proofId)).events.some((e:any)=>e.kind==='packing' && e.version==='2')?true:undefined;
      });
      await writeFile(path.join(root,'restart'),'');
      await poll('restart from protected state',()=>receipt('restarted.json'));
      dispatchTime=expected.clock.recovery;
      await writeFile(path.join(root,'dispatch-restored'),'');
      await referenceFile('dispatch-disconnected','POD-7791.pdf');
      await rename(held,path.join(root,'delivery'));
      await poll('recover and preserve the second PDF before its linking row',async()=>{
        const result=await db.db.query('SELECT 1 FROM record_order_receipts WHERE source_id=$1 AND file_name=$2',[source,'POD-7791.pdf']);
        return result.rows.length?true:undefined;
      });
      await poll('verified source recovery clears the incident',async()=>(await health()).incidents.some((i:any)=>i.sourceId===source)?undefined:true);
      const late=(await health()).overdue.find((o:any)=>o.proofId===pinned.proofId && o.id==='CTN-02');
      expect(late?.deadline).toBe(new Date(expected.clock.receiptDeadline).toISOString());
      expect(deliveries(await view(pinned.proofId))).toEqual(expected.split.deliveredBefore);
      await referenceFile('delivery','dispatch-late.csv');
      const complete=await poll('second delivery advances the original Proof',async()=>{
        const proof=await view(pinned.proofId);
        return proof.originalArtifacts.some((a:any)=>a.fileName==='POD-7791.pdf')?proof:undefined;
      });
      expect(complete.revision-pinned.revision).toBe(expected.recoveryRevisionDelta);
      expect(deliveries(complete)).toEqual(expected.split.deliveredAfter);
      expect((await health()).overdue.some((o:any)=>o.proofId===pinned.proofId && o.id==='CTN-02')).toBe(false);
      const delivery=complete.events.find((e:any)=>e.kind==='delivery' && e.entity.id==='POD-7791');
      expect(new Date(delivery.occurredAt).toISOString()).toBe(new Date(expected.clock.receipt2Event).toISOString());
      expect(new Date(delivery.firstSeenAt).toISOString()).toBe(new Date(expected.clock.recovery).toISOString());
      expect(delivery.observedAt).toBe(delivery.firstSeenAt);
      const agentLookup=await call('GET','/v1/partner/agent/order-proofs?q=CTN-02&referenceType=package',undefined,credentials);
      expect(agentLookup.orders[0]).toMatchObject({proofId:pinned.proofId,revision:complete.revision});
      expect((await lookup()).orders[0]).toMatchObject({proofId:pinned.proofId,revision:complete.revision});
      const completePacket=await poll('packet with both PDF originals',()=>verify.verifyOutput(output,complete).catch(()=>undefined));
      const manifest=JSON.parse(await readFile(path.join(output,completePacket.directory,'revision-'+String(complete.revision).padStart(8,'0'),'manifest.json'),'utf8'));
      expect(manifest.files.filter((f:any)=>f.kind==='original').map((f:any)=>f.sourceFileName).sort()).toEqual(['POD-7784.pdf','POD-7791.pdf']);
      expect(await readFile(originalPacket)).toEqual(previousPacket);
      for(const name of ['delivery-copy-1.csv','delivery-copy-2.csv'])await referenceFile('delivery','dispatch-late.csv',name);
      await poll('replayed original receipts acknowledged',async()=>{
        const result=await db.db.query('SELECT file_name FROM record_order_receipts WHERE source_id=$1 AND file_name LIKE $2',[source,'delivery-copy-%']);
        return result.rows.length===2?true:undefined;
      });
      expect(await view(pinned.proofId)).toEqual(complete);
      await referenceFile('delivery','dispatch-corrected.csv');
      const corrected=await poll('explicit correction to the dispatch event',async()=>{
        const p=await view(pinned.proofId); return p.events.some((e:any)=>e.kind==='delivery' && e.entity.id==='POD-7791' && e.version==='2')?p:undefined;
      });
      expect(corrected.revision).toBe(complete.revision+1);
      expect(await call('GET','/me/records/order-proofs/'+pinned.proofId+'/revisions/'+pinned.revision+query,undefined,adminHeaders)).toEqual(pinned);
      if(process.env.PACKPROOF_JOURNEY_VIEW_FIXTURE) {
        const packet=await call('POST','/me/records/order-proofs/'+pinned.proofId+'/revisions/'+pinned.revision+'/packet'+query,undefined,adminHeaders);
        await writeFile(process.env.PACKPROOF_JOURNEY_VIEW_FIXTURE,JSON.stringify({scope,locationId,search:await lookup(),pinned,corrected,packet}));
      }
      if(useBrowser) await checkInBrowser({id:corrected.proofId,revision:corrected.revision,carton:'CTN-02',historicalRevision:pinned.revision,locationId});
      if(process.env.PACKPROOF_JOURNEY_RESULT)await writeFile(process.env.PACKPROOF_JOURNEY_RESULT,JSON.stringify({
        proofId:pinned.proofId,partialRevision:pinned.revision,completeRevision:complete.revision,correctedRevision:corrected.revision,
        firstSeenAt:delivery.firstSeenAt,occurredAt:delivery.occurredAt,observedAt:delivery.observedAt,replays:2,pdfOriginals:2
      },null,2));
      return;
    }
    await publish('evidence','early_evidence.json');
    await publish('order','orders.json');mark('orderPublished');
    const first=await poll('earliest order capture',async()=>(await list()).orders?.find((o:any)=>o.orderReference==='SO10482'));
    const firstDoc=await view(first.proofId); expect(firstDoc.revision).toBe(1);mark('initialOnline');
    expect(firstDoc.events.some((e:any)=>e.eventId==='photo-94')).toBe(false);
    await publish('picking','picking.csv');await publish('packing','packages.xml');await publish('shipping','labels.json');
    await publish('shipping','label.zpl');
    const labelled=await poll('qualified label records',async()=>{const v=await view(first.proofId);return v.events.filter((x:any)=>x.kind==='label').length===2?v:undefined;});
    expect(labelled.events.some((x:any)=>x.kind==='handoff')).toBe(false);
    await publish('handoff','handoff.json');await publish('delivery','delivery.jsonl');
    await poll('delivery and split allocations',async()=>{const v=await view(first.proofId);return v.events.filter((x:any)=>x.kind==='delivery').length===2&&v.lines.find((l:any)=>l.lineId==='20')?.shippedQuantity==='2'?v:undefined;});
    await publish('packing','late_bridge.json');
    const completed=await poll('late evidence and original label bytes',async()=>{
      const v=await view(first.proofId);
      return v.events.some((e:any)=>e.eventId==='photo-94')&&v.originalArtifacts?.some((a:any)=>a.fileName==='label.zpl') ? v : undefined;
    });
    const verifier=await import('../../examples/multisource-journey/verify-output.mjs');
    await poll('completed proof before destination outage',async()=>{try{return await verifier.verifyOutput(path.join(root,'output'),completed);}catch{return undefined;}});
    const held=path.join(root,'disconnected-sample-output');
    await poll('interrupt controlled output destination',async()=>{
      try{await rename(path.join(root,'output'),held);return true;}
      catch(e){if(['EPERM','EACCES','EBUSY'].includes((e as NodeJS.ErrnoException).code||''))return undefined;throw e;}
    },12000);
    await verifier.verifyOutput(held,completed);
    await writeFile(path.join(root,'restart'),'');await poll('protected worker restart',()=>receipt('restarted.json'));
    // Exercise an actual Windows sharing violation, not a simulated reader error.
    // The producer rewrites the existing report while holding FileShare.None.
    const lockReady=path.join(root,'correction-lock-ready.json'),lockRelease=path.join(root,'correction-lock-release');
    const lockScript=[
      "$ErrorActionPreference='Stop'",
      "$bytes=[IO.File]::ReadAllBytes($env:PP_LOCK_INPUT)",
      "$deadline=[DateTime]::UtcNow.AddSeconds(15); $stream=$null",
      "while (!$stream) { try { $stream=[IO.File]::Open($env:PP_LOCK_TARGET,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::None) } catch [IO.IOException] { if ([DateTime]::UtcNow -ge $deadline) { throw }; Start-Sleep -Milliseconds 200 } }",
      "try {",
      "  $stream.SetLength(0); $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true)",
      "  [IO.File]::WriteAllText($env:PP_LOCK_READY,'{\"locked\":true}')",
      "  $deadline=[DateTime]::UtcNow.AddSeconds(90)",
      "  while (!(Test-Path -LiteralPath $env:PP_LOCK_RELEASE)) { if ([DateTime]::UtcNow -ge $deadline) { throw 'Lock release timed out' }; Start-Sleep -Milliseconds 200 }",
      "} finally { $stream.Dispose() }"
    ].join('\n');
    const writer=spawn('pwsh',['-NoProfile','-NonInteractive','-Command',lockScript],{
      windowsHide:true,stdio:['ignore','inherit','inherit'],env:{...process.env,PP_LOCK_INPUT:path.join(fixture,'corrections.json'),
        PP_LOCK_TARGET:path.join(root,'order','orders.json'),PP_LOCK_READY:lockReady,PP_LOCK_RELEASE:lockRelease}
    });
    let writerExit:number|null|undefined;
    const writerDone=new Promise<void>((resolve)=>{
      writer.once('exit',code=>{writerExit=code;resolve();});
      writer.once('error',()=>{writerExit=-1;resolve();});
    });
    let busySourceId:string|undefined;
    try {
      await poll('producer holds exclusive Windows report lock',async()=>{
        if(writerExit!==undefined)throw Error('Locked report producer exited '+writerExit);
        return (await receipt('correction-lock-ready.json'))?.locked===true?true:undefined;
      },20000);
      await expect(readFile(path.join(root,'order','orders.json'))).rejects.toThrow();
      const busy=await poll('collector reports the real sharing violation',async()=>{
        if(writerExit!==undefined)throw Error('Locked report producer exited '+writerExit);
        const state=await receipt('service-status.json');
        return state?.workspace?.sources?.find((source:any)=>source.issue==='SOURCE_BUSY');
      });
      busySourceId=busy.id;
      // The incomplete/locked revision must never become a committed Proof.
      const whileLocked=await view(first.proofId);
      expect(whileLocked.lines.find((l:any)=>l.lineId==='20')?.orderedQuantity).toBe('2');
      expect(writerExit).toBeUndefined();
      mark('lockedSourceObserved');
    } finally {
      await writeFile(lockRelease,'');
      await Promise.race([writerDone,wait(10000)]);
      if(writerExit===undefined){writer.kill();await writerDone;}
    }
    expect(writerExit).toBe(0);mark('correctionPublished');
    const final=await poll('same proof receives quantity correction',async()=>{const v=await view(first.proofId);return v.lines.find((l:any)=>l.lineId==='20')?.orderedQuantity==='3'?v:undefined;});
    expect(final.proofId).toBe(first.proofId);
    expect(final.revision).toBeGreaterThan(completed.revision);
    await poll('collector recovers the locked source without another approval',async()=>{
      const state=await receipt('service-status.json');
      const source=state?.workspace?.sources?.find((item:any)=>item.id===busySourceId);
      return source && source.issue!=='SOURCE_BUSY' ? true : undefined;
    });
    const comparison = '1 EA more ordered than shipped';
    expect(final.lines.find((l:any)=>l.lineId==='20')).toMatchObject({orderedQuantity:'3',shippedQuantity:'2',unit:'each',
      orderedMinusShippedQuantity:'1',orderedShippedDiscrepancy:comparison});
    expect(completed.lines.find((l:any)=>l.lineId==='20').orderedMinusShippedQuantity).toBe('0');
    const previous = await call('GET','/v1/partner/agent/order-proofs/'+first.proofId+'/revisions/'+completed.revision,undefined,credentials);
    expect(previous).toEqual(completed);
    mark('correctedOnline');
    const serviceView=await call('GET','/v1/partner/agent/order-proofs/'+first.proofId+'/revisions/'+final.revision,undefined,credentials);
    expect(serviceView).toEqual(final);
    await verifier.verifyOutput(held,completed);
    await rename(held,path.join(root,'output')); mark('destinationRestored');
    const checked=await poll('latest published output bundle',async()=>{try{return await verifier.verifyOutput(path.join(root,'output'),final);}catch{return undefined;}});
    const inventory=JSON.parse(await readFile(path.join(root,'output',checked.directory,'revision-'+String(final.revision).padStart(8,'0'),'manifest.json'),'utf8'));
    const summary=await readFile(path.join(root,'output',checked.directory,'revision-'+String(final.revision).padStart(8,'0'),'summary.html'),'utf8');
    const correctedRow=summary.match(/<tr><td>20<\/td>.*?<\/tr>/)?.[0];
    expect(correctedRow).toContain('<td>'+comparison+'</td>');
    const label=inventory.files.find((e:any)=>e.kind==='original' && e.sourceFileName==='label.zpl');
    expect(label?.originalSha256).toBe(final.originalArtifacts.find((a:any)=>a.fileName==='label.zpl').originalSha256);
    expect(await readFile(path.resolve(root,'output',checked.directory,'revision-'+String(final.revision).padStart(8,'0'),label.file))).toEqual(await readFile(path.join(fixture,'label.zpl')));
    mark('outputVerified');
    if(useBrowser) await checkInBrowser({id:first.proofId,revision:final.revision});
    const status=await poll('desktop service projection of committed order',async()=>{const s=await receipt('service-status.json');return s?.workspace?.orders?.some((o:any)=>o.proofId===first.proofId&&o.revision===final.revision)?s:undefined;});
    const historical=await poll('historical API order under original proof ID',async()=>(await list()).orders.find((r:any)=>r.proofId===earlier.proofId));
    expect((await view(historical.proofId)).evidence.some((r:any)=>r.originalStatus==='original_unavailable')).toBe(true);
    const senderSource=session.sources.find((r:any)=>r.transport==='api');
    const binding={installationId:enrolled.installationId,scopeDigest:session.scopeDigest,sourceId:senderSource.id,generation:senderSource.generation};
    const cloud=await call('POST','/v1/partner/proofs',{...partnerOrder,externalId:'API-LIVE',connectOperation:binding},{...merchant,'Idempotency-Key':'after-approval'});
    const cloudView=await view(cloud.proofId);
    expect(cloudView.orderReference).toBe('API-LIVE');
    await poll('local package for cloud-only order',async()=>{try{return await verifier.verifyOutput(path.join(root,'output'),cloudView);}catch{return undefined;}});
    expect(Object.keys(routes).some(route=>route.startsWith('POST ') && route.endsWith('/agent/order-workspace/reconcile-api-source 200'))).toBe(true);
    const perfCount=Number(process.env.PACKPROOF_JOURNEY_PERF_N || 0);
    if(perfCount) phase="latency measurement";
    const benchmark=perfCount ? await measureOrderLatency(db.db,root,perfCount,()=>exited!==undefined) : undefined;
    const initial=await call('GET','/me/records/order-proofs/'+first.proofId+'/revisions/'+firstDoc.revision+query,undefined,adminHeaders);
    expect(initial).toEqual(firstDoc);
    await call('POST','/me/records/agent-installations/'+enrolled.installationId+'/actions'+query,
      {...scope,action:'revoke'},{...adminHeaders,'Idempotency-Key':'revoke-controlled-computer'});
    await expect(call('GET','/v1/partner/agent/order-proofs/'+first.proofId+'/revisions/'+final.revision,undefined,credentials)).rejects.toThrow(/ 40[13] /);
    await poll('revoked computer clears scoped order cards',async()=>{
      const state=await receipt('service-status.json');
      return state?.workspace?.canReadOrders===false && state.workspace.orders.length===0 ? true : undefined;
    },85000);
    expect((await view(first.proofId)).revision).toBe(final.revision);
    await verifier.verifyOutput(path.join(root,'output'),final);
    const msg={benchmark,scope:'isolated application; real HTTP over Windows pipe, C# command runtime and filesystem, browser authorization endpoint, database, immutable originals, service dashboard feed and local writer',
      proofId:first.proofId,earliestRevision:firstDoc.revision,latestRevision:final.revision,verifiedFiles:checked.filesVerified,
      activeSources:status.workspace.sources.length,browserApproval:useBrowser,cloudOrderExported:true,historicalApiProofIdPreserved:true,originalLabelBytes:true,lateEvidence:true,priorOutputSurvivedOutage:true,lockedSourceObserved:true,lockedSourceRecovered:true,revocationClearedDesktop:true,firstRevisionPreserved:true,timings,onlineAfterCorrectionMs:Date.parse(timings.correctedOnline)-Date.parse(timings.correctionPublished),
      localAfterCommitObservedMs:Date.parse(timings.outputVerified)-Date.parse(timings.correctedOnline),routes};
    if(process.env.PACKPROOF_JOURNEY_RESULT)await writeFile(process.env.PACKPROOF_JOURNEY_RESULT,JSON.stringify(msg,null,2));
    console.log('Real HTTP journey',JSON.stringify({earliest:firstDoc.revision,latest:final.revision,verifiedFiles:checked.filesVerified,timings}));
  } catch(error) {
    const s=await receipt('service-status.json');
    console.error('Journey checkpoint',phase,JSON.stringify({routes,error:s?.lastError,output:s?.output?.errorCode,attention:s?.workspace?.attention,
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
