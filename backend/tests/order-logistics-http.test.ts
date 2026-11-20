import request from 'supertest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Agent,createServer} from 'node:http';
import {tmpdir} from 'node:os';
import pathModule from 'node:path';
import {cp,mkdtemp,readFile,rm} from 'node:fs/promises';
import {afterEach,expect,it,vi} from 'vitest';
import {createHarness,createUser,auth} from './helpers.js';
import {createOrganization,setOrganizationEntitlement} from '../src/platform/organizations.js';
import {sha256Hex} from '../src/hash.js';
import {createPgliteDatabase} from '../src/db/pglite.js';
import {LocalObjectStore} from '../src/s3/local-object-store.js';

afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

it('recovers the late carton once and enforces scoped lookups, actions and original access on the pinned revision',async()=>{
  vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');
  vi.stubEnv('PACKPROOF_ORDER_WORKSPACE_ENABLED','true');
  vi.stubEnv('PACKPROOF_WEBHOOK_ENCRYPTION_KEY',randomBytes(32).toString('base64'));
  let now='2026-11-19T19:18:00Z';
  const clock={now:()=>new Date(now)};
  const workspace=await mkdtemp(pathModule.join(tmpdir(),'order-restore-'));
  const source=pathModule.join(workspace,'source');
  const open=async(directory:string)=>{
    const opened=await createPgliteDatabase(pathModule.join(directory,'db'));
    const objectStore=new LocalObjectStore(pathModule.join(directory,'objects'),'http://localhost','test-upload-secret');
    try{
      const harness=await createHarness(clock,{opened,objectStore});
      return {...harness,close:async()=>{await harness.close();await opened.close();}};
    }catch(error){await opened.close();throw error;}
  };
  let h=await open(source);
  let databaseOpen=true;
  const name='packproof-logistics-'+randomUUID();
  const socket=process.platform==='win32' ? '\\\\.\\pipe\\'+name : pathModule.join(tmpdir(),name+'.sock');
  const http=createServer((req,res)=>h.app(req,res));
  const transport=new Agent({keepAlive:false,socketPath:socket});
  try {
    await new Promise<void>((resolve,reject)=>{http.once('error',reject);http.listen(socket,resolve);});
    const [developer,owner,reviewer]=await Promise.all([createUser(h),createUser(h),createUser(h)]);
    await h.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[developer,now]);
    const org=(await createOrganization(h.db,clock,developer,{kind:'MERCHANT',name:'Reference operation',ownerUserId:owner},'fixture')).id;
    await setOrganizationEntitlement(h.db,clock,developer,org,{enabled:true},'fixture');
    const scope={organizationId:org,environment:'sandbox'};
    vi.stubEnv('PACKPROOF_GUIDED_FACILITIES',org+':sandbox:east');
    vi.stubEnv('PACKPROOF_SETUP_AI_FACILITIES',org+':sandbox:east');
    vi.stubEnv('PACKPROOF_SETUP_AI_PROVIDER','openai');
    vi.stubEnv('PACKPROOF_SETUP_AI_MODEL','fixture');
    vi.stubEnv('PACKPROOF_SETUP_AI_KEY','test-only');
    const draftId=randomUUID();
    const member=(await h.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[org,owner])).rows[0].id;
    await h.db.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,created_at,location_scoped) VALUES('reviewer',$1,$2,'REVIEWER',$3,true)",[org,reviewer,now]);
    for (const site of ['east','west']) await h.db.query('INSERT INTO record_locations VALUES($1,$2,$1,$3)',[site,org,now]);
    await h.db.query("INSERT INTO record_membership_locations VALUES('reviewer',$1,'east')",[org]);
    const api=request.agent('http://localhost').use(req=>req.agent(transport)), human='/me/records', agent='/v1/partner/agent';
    const success=async (req:request.Test)=>{
      const response=await req;
      expect(response.status,JSON.stringify(response.body)).toBeGreaterThanOrEqual(200);
      expect(response.status,JSON.stringify(response.body)).toBeLessThan(300);
      return response.body;
    };
    async function enroll(site:string) {
      const e=await success(api.post('/connect/enrollments').send({deviceName:'Collector '+site,version:'0.7.0'}));
      const installation=await success(api.post(human+'/agent-enrollments/'+e.id+'/decision').set(auth(owner))
        .set('Idempotency-Key','enroll-'+site).send({...scope,decision:'approve',comparisonCode:e.comparisonCode,
          operatorMembershipId:member,locationId:site,sourceName:'Test files',integrationAccountId:null,createLocalSource:true}));
      const grant=await success(api.post('/connect/enrollments/'+e.id+'/redeem').send({redeemSecret:e.redeemSecret}));
      const device={Authorization:'Bearer '+grant.token,'PackProof-Merchant-Id':org};
      await success(api.post(agent+'/heartbeat').set(device).send({version:'0.7.0',queueCount:0,enrollmentAcknowledged:true}));
      const proposal=await success(api.post(agent+'/order-workspace/proposals').set(device).send({
        sources:[{id:'dispatch',generation:1,folderDigest:'a'.repeat(64),roles:['order','packing','shipping','handoff','delivery'],profileVersion:'logistics/v1',
          ...(site==='east'?{expectedCheckIntervalSeconds:300,expectedDeliveryAfterLabelSeconds:86400}:{})}],
        ...(site==='east'?{testedProfile:{schema:'packproof.facility-replay/v1',digest:'c'.repeat(64),draftId,revision:2,examples:3}}:{}),
        outputDigest:'b'.repeat(64),history:'existing_and_future'}));
      await success(api.post(human+'/agent-installations/'+installation.installationId+'/order-workspace/'+proposal.id+'/decision')
        .set(auth(owner)).send({...scope,decision:'approve',scopeDigest:proposal.scopeDigest}));
      return {device,id:installation.installationId,scopeDigest:proposal.scopeDigest};
    }
    const east=await enroll('east'),west=await enroll('west');
    const workPath=agent+'/order-workspace';
    const approved=await success(api.get(workPath).set(east.device).query({scopeDigest:east.scopeDigest}));
    const changed={...approved.scope,testedProfile:{...approved.scope.testedProfile,revision:3,digest:'d'.repeat(64)}};
    const pending=await success(api.post(workPath+'/proposals').set(east.device).send(changed));
    expect(pending.scopeDigest).not.toBe(approved.scopeDigest);
    expect((await success(api.post(workPath+'/proposals').set(east.device).send(changed))).id).toBe(pending.id);
    const decision=human+'/agent-installations/'+east.id+'/order-workspace/'+pending.id+'/decision';
    await api.post(decision).set(auth(owner)).send({...scope,decision:'approve',scopeDigest:approved.scopeDigest}).expect(409);
    await api.post(workPath+'/withdraw').set(west.device).send({scopeDigest:pending.scopeDigest}).expect(409);
    await success(api.post(workPath+'/withdraw').set(east.device).send({scopeDigest:pending.scopeDigest}));
    await success(api.post(workPath+'/withdraw').set(east.device).send({scopeDigest:pending.scopeDigest}));
    await api.post(decision).set(auth(owner)).send({...scope,decision:'approve',scopeDigest:pending.scopeDigest}).expect(409);
    expect((await success(api.get(workPath).set(east.device).query({scopeDigest:approved.scopeDigest}))).state).toBe('active');
    await api.post(workPath+'/proposals').set(east.device).send({...changed,
      sources:changed.sources.map((s:Record<string,unknown>)=>({...s,profileVersion:'unapproved-reader'}))}).expect(409);
    const provider=vi.fn<typeof fetch>(async (url,init)=>{
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      const sent=JSON.parse(String(init?.body));
      expect(JSON.parse(sent.messages[1].content)).toEqual({steps:['label'],fields:[{handle:'f1',label:'Shipped At',type:'datetime'}]});
      return Response.json({choices:[{message:{content:JSON.stringify({suggestions:[
        {operation:'ask_question',step:'label',field:'f1',meaning:'unknown',reason:'ambiguous_time'}]})}}]});
    });
    vi.stubGlobal('fetch',provider);
    const setupUrl=(id:string)=>human+'/agent-installations/'+id;
    const setup={draftId,revision:2,consent:true,steps:['label'],fields:[{handle:'f1',label:'Shipped At',type:'datetime'}]};
    const suggest=(id:string,user:string,input=setup)=>api.post(setupUrl(id)+'/facility-setup/suggestions/v1').set(auth(user)).query(scope).send(input);
    expect((await success(api.get(setupUrl(east.id)+'/workspace-access').set(auth(owner)).query(scope))).canConfigure).toBe(true);
    expect((await success(api.get(setupUrl(east.id)+'/workspace-access').set(auth(reviewer)).query(scope))).canConfigure).toBe(false);
    await suggest(west.id,owner).expect(404);
    await suggest(east.id,reviewer).expect(404);
    expect(provider).not.toHaveBeenCalled();
    const suggestion=await success(suggest(east.id,owner));
    expect(suggestion.suggestions[0].operation).toBe('ask_question');
    expect(await success(suggest(east.id,owner))).toEqual(suggestion);
    const review={draftId,revision:2,requestId:suggestion.requestId,index:0,decision:'edited'};
    const reviewUrl=setupUrl(east.id)+'/facility-setup/reviews/v1';
    for(let retry=0;retry<2;retry++) await api.post(reviewUrl).set(auth(owner)).query(scope).send(review).expect(204);
    await api.post(reviewUrl).set(auth(owner)).query(scope).send({...review,decision:'accepted'}).expect(409);
    await suggest(east.id,owner,{...setup,revision:1}).expect(409);
    expect(provider).toHaveBeenCalledTimes(1);
    provider.mockRejectedValueOnce(Error('Deliberately offline'));
    await suggest(east.id,owner,{...setup,revision:3}).expect(503);
    expect(provider).toHaveBeenCalledTimes(2);
    const health=(time:string,state:string)=>success(api.post(agent+'/order-workspace/source-health').set(east.device)
      .send({scopeDigest:east.scopeDigest,sourceId:'dispatch',generation:1,state,checkedAt:time,lastVerifiedReadAt:time}));
    await health(now,'current');
    const ref=(type:string,id:string)=>({type,id,namespace:'warehouse'});
    const order=ref('order','export.order482'),carton1=ref('package','CTN-01'),carton2=ref('package','CTN-02');
    const row=(eventId:string,kind:string,entity:typeof order,references:typeof order[],occurredAt:string,fields={})=>({
      eventId,version:'1',kind,entity,references,occurredAt,fields,locator:'row 2',lines:[]});
    const origin=row('order','order',order,[],'2026-11-19T20:00:00+07:00',{orderReference:'SO-10482'});
    const initial=[origin,row('pack1','packing',carton1,[order],'2026-11-19T08:30:00-05:00'),
      row('pack2','packing',carton2,[order],'2026-11-19T08:30:00-05:00'),
      row('label2','label',carton2,[order],'2026-11-19T08:42:00-05:00'),row('pod1','delivery',carton1,[order],'2026-11-19T14:16:00-05:00')];
    async function submit(site:typeof east,id:string,records:unknown[],file=id+'.json',bytes=Buffer.from(JSON.stringify(records))) {
      return success(api.post(agent+'/order-workspace/observations').set(site.device).send({scopeDigest:site.scopeDigest,
        sourceId:'dispatch',generation:1,profileVersion:'logistics/v1',observationId:id,fileName:file,
        mediaType:file.endsWith('.pdf')?'application/pdf':'application/json',originalSha256:sha256Hex(bytes),
        originalBase64:bytes.toString('base64'),records,firstSeenAt:now}));
    }
    const prior=(await submit(east,'initial',initial)).proofs[0];
    const other=(await submit(west,'initial',[origin])).proofs[0];
    const lookup=(user:string,type:string,q:string)=>success(api.get(human+'/order-proofs').set(auth(user)).query({...scope,referenceType:type,q}));
    expect((await lookup(owner,'order','SO-10482')).orders).toHaveLength(2);
    expect((await lookup(reviewer,'order','SO-10482')).orders.map((x:{proofId:string})=>x.proofId)).toEqual([prior.proofId]);
    await api.get(human+'/order-proofs/'+other.proofId).set(auth(reviewer)).query(scope).expect(404);
    const card=(await lookup(reviewer,'package','CTN-02')).orders[0];
    expect(card).toMatchObject({...prior,latestKind:'delivery',locationId:'east',matchedSubjects:[{...carton2,sourceId:'dispatch'}]});
    const devicePage=await success(api.get(agent+'/order-proofs').set(east.device).query({referenceType:'package',q:'CTN-02'}));
    expect(devicePage.orders).toEqual([card]);
    const path=human+'/order-proofs/'+prior.proofId;
    const pin=path+'/revisions/'+prior.revision;
    const inspect=(url:string,user=owner)=>success(api.get(url).set(auth(user)).query(scope));
    const before=await inspect(pin);
    expect(before.cartons).toMatchObject([{id:'CTN-01',deliveryStatus:'delivered'}, {id:'CTN-02',lastEventKind:'label',deliveryStatus:'awaiting_evidence'}]);
    const body={...scope,caseKey:'carton:warehouse:CTN-02',action:'request_receipt',reason:'Confirm carton 02',expectedRevision:prior.revision,expectedVersion:0};
    await api.post(path+'/case-actions').set(auth(reviewer)).set('Idempotency-Key','case-blocked').send(body).expect(403);
    expect((await success(api.post(path+'/case-actions').set(auth(owner)).set('Idempotency-Key','request-pod').send(body))).version).toBe(1);
    now='2026-11-19T19:30:00Z';
    const stale=await inspect(human+'/order-source-health',reviewer);
    expect(stale.incidents).toMatchObject([{sourceId:'dispatch',state:'delayed',affectedOrders:[{proofId:prior.proofId}]}]);
    now='2026-11-19T19:34:00Z';
    await health(now,'current');
    expect((await inspect(human+'/order-source-health',reviewer)).incidents).toEqual([]);
    expect((await inspect(path)).cartons[1].deliveryStatus).toBe('awaiting_evidence');
    const pdf=await readFile(new URL('../../examples/multisource-journey/reference/POD-7791.pdf',import.meta.url));
    await submit(east,'binary',[],'POD-7791.pdf',pdf);
    const delivery=row('pod2','delivery',carton2,[order],'2026-11-19T14:19:00-05:00',{artifactSha256:sha256Hex(pdf)});
    const late=await submit(east,'pod2',[delivery]);
    const revision=prior.revision+1;
    expect(late.proofs).toEqual([{proofId:prior.proofId,revision}]);
    for(let i=0;i<2;i++) expect((await submit(east,'pod2',[delivery])).proofs).toEqual(late.proofs);
    const current=await inspect(path);
    expect(current.cartons[1]).toMatchObject({id:'CTN-02',deliveryStatus:'delivered',occurredAt:delivery.occurredAt,observedAt:'2026-11-19T19:34:00.000Z'});
    expect(current.events.find((e:{eventId:string})=>e.eventId==='pod2').firstSeenAt).toBe('2026-11-19T19:34:00.000Z');
    expect(current.deliveryCoverage).toBe('configured');
    expect(current.changes).toEqual(expect.arrayContaining([expect.objectContaining({kind:'added',subject:carton2,sourceId:'dispatch'}),
      expect.objectContaining({kind:'original_attached',originalSha256:sha256Hex(pdf)})]));
    expect(await inspect(pin)).toEqual(before);
    const artifact=path+'/revisions/'+revision+'/artifacts/'+current.originalArtifacts[0].receiptId;
    expect((await inspect(artifact)).bytesBase64).toBe(pdf.toString('base64'));
    await api.get(artifact).set(auth(reviewer)).query(scope).expect(403);
    const toggle=(allowed:boolean)=>success(api.put(human+'/agent-installations/'+east.id+'/order-original-access').set(auth(owner))
      .send({...scope,membershipId:'reviewer',allowed,reason:'Reference access qualification'}));
    await toggle(true);
    expect((await inspect(artifact,reviewer)).bytesBase64).toBe(pdf.toString('base64'));
    await toggle(false);
    await api.get(artifact).set(auth(reviewer)).query(scope).expect(403);
    const packet=await success(api.post(path+'/revisions/'+revision+'/packet').set(auth(reviewer)).query(scope));
    expect(packet.contents).toEqual([]);
    expect(packet.manifest.every((m:{disposition:string})=>m.disposition==='omitted')).toBe(true);
    expect((await success(api.post(path+'/case-actions').set(auth(owner)).set('Idempotency-Key','resolve-pod')
      .send({...body,action:'resolve',expectedVersion:1,expectedRevision:revision}))).version).toBe(2);
    await api.post(path+'/case-actions').set(auth(owner)).set('Idempotency-Key','resolve-again')
      .send({...body,action:'resolve',expectedVersion:2,expectedRevision:revision}).expect(409);
    const quantity={...origin,eventId:'quantity',fields:{reportedQuantity:'1'},lines:[{lineId:'line1',unit:'EA',orderedQuantity:'1'}]};
    await submit(east,'quantity-1',[quantity]);
    const change={...quantity,version:'3',fields:{reportedQuantity:'3'},lines:[{lineId:'line1',unit:'EA',orderedQuantity:'3'}]};
    await submit(east,'quantity-3',[change]);
    const corrected=await inspect(path);
    expect(corrected.changes).toMatchObject([{kind:'updated',fields:expect.arrayContaining([
      {scope:'line/line1',field:'orderedQuantity',previous:'1',current:'3'}])}]);
    await submit(east,'quantity-2',[{...quantity,version:'2',fields:{reportedQuantity:'2'}}]);
    const delayed=await inspect(path);
    expect(delayed.lines[0].orderedQuantity).toBe('3');
    expect(delayed.evidence.filter((e:{eventId:string})=>e.eventId==='quantity')).toHaveLength(3);
    // A retry or renamed copy with the exact same bytes keeps the revision. A
    // different original for the same source/version is held, even when the
    // parser maps both originals to the same quantities.
    expect((await submit(east,'renamed',[change],'another.json')).proofs[0].revision).toBe(delayed.revision);
    const whitespaceChanged=Buffer.from(JSON.stringify([change],null,2));
    for(const id of ['conflict-a','conflict-b']) {
      const held=await submit(east,id,[change],id+'.json',whitespaceChanged);
      expect(held).toMatchObject({state:'pending',code:'REVISION_CONFLICT'});
    }
    expect((await inspect(path)).revision).toBe(delayed.revision);
    const attention=await inspect(human+'/order-attention');
    expect(attention.items.filter((e:{eventKey:string})=>e.eventKey.startsWith('order_conflict_'))).toHaveLength(1);
    expect(provider).toHaveBeenCalledTimes(2);
    const secondOrder=ref('order','export.order483'),shipment=ref('shipment','SHP-CONSOLIDATED');
    const second=(await submit(east,'second-order',[row('second-order','order',secondOrder,[],now)])).proofs[0];
    await submit(east,'consolidated',[row('consolidated','handoff',shipment,[order,secondOrder],now)]);
    const common=await lookup(reviewer,'shipment',shipment.id);
    expect(common.orders.map((c:{proofId:string})=>c.proofId).sort()).toEqual([prior.proofId,second.proofId].sort());
    for(const c of common.orders) expect(c.matchedSubjects).toEqual([{...shipment,sourceId:'dispatch'}]);
    expect((await lookup(reviewer,'order',secondOrder.id)).orders.map((c:{proofId:string})=>c.proofId)).toEqual([second.proofId]);
    // Reopen a cold database copy and the matching object versions under a new root.
    await h.close();
    databaseOpen=false;
    const restored=pathModule.join(workspace,'restored');
    await cp(source,restored,{recursive:true});
    h=await open(restored);
    databaseOpen=true;
    expect(await inspect(pin)).toEqual(before);
    expect((await inspect(artifact)).bytesBase64).toBe(pdf.toString('base64'));
    await api.get(artifact).set(auth(reviewer)).query(scope).expect(403);
    expect(provider).toHaveBeenCalledTimes(2);
    // Roll back this facility after restoring its data. A stale approval cannot
    // reopen collection, and the independently authorized west operation stays live.
    vi.stubEnv('PACKPROOF_GUIDED_FACILITIES','');
    expect(await success(api.get(workPath).set(east.device).query({scopeDigest:east.scopeDigest})))
      .toMatchObject({state:'paused',offlineWindowSeconds:0});
    await api.get(agent+'/order-proofs').set(east.device).expect(403);
    await api.post(workPath+'/proposals').set(east.device).send(approved.scope).expect(409);
    expect((await success(api.get(workPath).set(west.device))).state).toBe('active');
    expect((await submit(west,'initial',[origin])).proofs).toEqual([other]);
    expect(await inspect(pin)).toEqual(before);
    const {testedProfile: rolledBackProfile,...manual}=approved.scope;
    expect(rolledBackProfile.digest).toBeTruthy();
    const replacement=await success(api.post(workPath+'/proposals').set(east.device).send(manual));
    expect(replacement).toMatchObject({state:'pending'});
    await api.get(agent+'/order-proofs').set(east.device).expect(403);
    await success(api.post(setupUrl(east.id)+'/order-workspace/'+replacement.id+'/decision').set(auth(owner))
      .send({...scope,decision:'approve',scopeDigest:replacement.scopeDigest}));
    expect((await success(api.get(workPath).set(east.device).query({scopeDigest:east.scopeDigest}))).state).toBe('superseded');
    expect((await success(api.get(workPath).set(east.device).query({scopeDigest:replacement.scopeDigest}))).state).toBe('active');
    expect((await inspect(artifact)).bytesBase64).toBe(pdf.toString('base64'));
  } finally {
    transport.destroy();
    if(http.listening) await new Promise<void>(resolve=>http.close(()=>resolve()));
    try{if(databaseOpen) await h.close();}finally{await rm(workspace,{recursive:true,force:true});}
  }
},60000);
