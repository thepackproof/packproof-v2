import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {LocalObjectStore} from '../src/s3/local-object-store.js';
import {insertUser} from '../src/domain/users.js';
import {createOrganization,setOrganizationEntitlement,createServicePrincipal,createIntegrationAccount,issuePartnerCredential,authenticatePartner} from '../src/platform/organizations.js';
import {importPartnerOrder} from '../src/platform/partner-proofs.js';
import {agentView,startEnrollment,decideEnrollment,redeemEnrollment,heartbeatAgent,loadInstallation} from '../src/records/agent-enrollments.js';
import {requireRecordWorkspace} from '../src/records/access.js';
import {proposeScope,decideSession,checkedInstallation} from '../src/records/order-workspace.js';
import {reconcileApiHistory,setApiSourcePaused} from '../src/records/order-api-history.js';
import {importCloudOrder} from '../src/records/cloud-order.js';
import type {AppDependencies} from '../src/app.js';

afterEach(()=>vi.unstubAllEnvs());

it('reconciles an existing partner snapshot exactly once, keeps its original proof ID, and fences direct intake on pause',async()=>{
  for(const flag of ['ORGANIZATIONS','SOURCE_SUBSCRIPTIONS','MULTI_SOURCE_AGENT','TYPED_INTAKE','ORDER_WORKSPACE','CASE_RECONSTRUCTION','SOURCE_IDENTITY_V2'])vi.stubEnv('PACKPROOF_'+flag+'_ENABLED','true');
  vi.stubEnv('PACKPROOF_TEST_DATABASE_URL','');
  const opened=await openIsolatedTestDatabase(),db=opened.db,clock={now:()=>new Date()};
  const root=await mkdtemp(path.join(os.tmpdir(),'pp-api-orders-'));
  const deps={db,clock,devAuth:true,testFixtures:true,objectStore:new LocalObjectStore(root,'https://example.test','fixture'),
    webhookConfig:{encryptionKey:Buffer.alloc(32,3).toString('base64')}} as AppDependencies;
  try{
    await migrate(db);
    const admin=await insertUser(db,clock), owner=await insertUser(db,clock);
    await db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
    const org=(await createOrganization(db,clock,admin,{kind:'MERCHANT',name:'Test operation',ownerUserId:owner},'fixture')).id;
    await setOrganizationEntitlement(db,clock,admin,org,{enabled:true},'fixture');
    const user=await requireRecordWorkspace(db,owner,org,'sandbox',true);
    const account=(await createIntegrationAccount(db,clock,owner,org,{provider:'partner',externalAccountId:'controlled-erp'},'fixture')).id;
    const principal=await createServicePrincipal(db,clock,owner,org,{name:'Order sender'},'fixture');
    const cred=await issuePartnerCredential(db,clock,owner,org,principal.id,{scopes:['proofs:write','proofs:read'],expiresAt:new Date(Date.now()+86400000).toISOString()},'fixture');
    const merchant=await authenticatePartner(db,clock,'Bearer '+cred.token,org,undefined,'test');
    const body={integrationAccountId:account,operatorMembershipId:user.membershipId,externalId:'SO10480',transaction:{itemTitle:'Test item',quantity:2}};
    const previous=await importPartnerOrder(db,clock,merchant,body);
    const enrollment=await startEnrollment(deps,{deviceName:'Install',version:'0.5.0'});
    const approval=await db.transaction(tx=>decideEnrollment(deps,tx,user,enrollment.id,{decision:'approve',comparisonCode:enrollment.comparisonCode,
      operatorMembershipId:user.membershipId,locationId:null,sourceName:'Direct order feed',integrationAccountId:account},'fixture'));
    const redeemed=await redeemEnrollment(deps,enrollment.id,{redeemSecret:enrollment.redeemSecret}) as {token:string};
    const device=await authenticatePartner(db,clock,'Bearer '+redeemed.token,org,undefined,'fixture');
    await heartbeatAgent(deps,device,{version:'0.5.0',enrollmentAcknowledged:true,queueCount:0});
    const installation=await checkedInstallation(db,clock,device,true);
    expect(installation.id).toBe(approval.installationId);
    const source={id:'api-source',generation:1,folderDigest:'a'.repeat(64),transport:'api',sourceNamespace:'ERP_A',profileVersion:'packproof.partner-order/v1',roles:['order']};
    const request=await db.transaction(tx=>proposeScope(tx,clock,installation,{sources:[source],outputDigest:'b'.repeat(64),history:'existing_and_future'}));
    if(!('id' in request) || !request.id)throw new Error('Missing source session');
    await db.transaction(tx=>decideSession(tx,clock,user,installation.id,request.id,{decision:'approve',scopeDigest:request.scopeDigest,environment:'sandbox',organizationId:org}));
    const binding={scopeDigest:request.scopeDigest,sourceId:source.id,generation:1};
    const runHistory=()=>db.transaction(tx=>reconcileApiHistory(deps,tx,device,installation,binding));
    expect(await runHistory()).toMatchObject({processed:1,state:'current'});
    expect(await runHistory()).toMatchObject({processed:0,state:'current'});
    const view=(await db.query<{view:{evidence:{originalStatus:string}[]}}>('SELECT view FROM record_order_revisions WHERE proof_id=$1 ORDER BY revision DESC LIMIT 1',[previous.proofId])).rows[0].view;
    expect(view.evidence[0].originalStatus).toBe('original_unavailable');
    const next={...body,externalId:'SO10481',connectOperation:{...binding,installationId:installation.id}};
    const submit=()=>db.transaction(tx=>importCloudOrder(deps,tx,merchant,next,Buffer.from(JSON.stringify(next))));
    await db.transaction(tx=>setApiSourcePaused(tx,installation,{...binding,paused:true}));
    await expect(submit()).rejects.toMatchObject({code:'CONNECTION_PAUSED'});
    await db.transaction(tx=>setApiSourcePaused(tx,installation,{...binding,paused:false}));
    expect(await submit()).toMatchObject({created:true,connectedOrder:true});
    expect(await submit()).toMatchObject({created:false});
  }finally{await opened.close();await rm(root,{recursive:true,force:true});}
},60000);

