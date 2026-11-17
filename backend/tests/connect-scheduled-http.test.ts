import {afterAll, beforeAll, expect, it, vi} from 'vitest';
import {createServer, type Server} from 'node:http';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import inProcess from './in-process-http.js';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {BearerUserAdapter} from '../src/auth/adapter.js';
import type {AppDependencies} from '../src/app.js';
import {createServerApp} from '../src/server-app.js';
import {DisabledEmailDelivery} from '../src/integrations/email/delivery.js';
import {LocalObjectStore} from '../src/s3/local-object-store.js';
import {createOrganization, createIntegrationAccount, setOrganizationEntitlement} from '../src/platform/organizations.js';
import {processPendingPartnerImports} from '../src/records/partner-imports.js';
import {CSV_RULES} from '../src/records/csv-semantics.js';
import {sha256Hex} from '../src/hash.js';

const loopback = process.env.PACKPROOF_TEST_LOOPBACK_HTTP === 'true';
const clock = {now: () => new Date()};
let opened: Awaited<ReturnType<typeof openIsolatedTestDatabase>>;
let deps: AppDependencies, objects: string, app: ReturnType<typeof createServerApp>, server: Server|undefined;
let organizationId: string, owner: string, integrationAccountId: string, operatorMembershipId: string;
const scope = () => ({organizationId, environment:'sandbox'});

beforeAll(async () => {
  vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');
  vi.stubEnv('PACKPROOF_SHIPMENT_INTERPRETATION_ENABLED','true');
  vi.stubEnv('PACKPROOF_SHIPMENT_WORKER_INTERPRETATION',CSV_RULES.interpretation.version);
  opened = await openIsolatedTestDatabase();
  await migrate(opened.db);
  const developer = await insertUser(opened.db,clock);
  owner = await insertUser(opened.db,clock);
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES ($1,'nericollin@gmail.com',$2,'COGNITO')",[developer,clock.now().toISOString()]);
  organizationId = (await createOrganization(opened.db,clock,developer,{kind:'MERCHANT',name:'Synthetic CSV acceptance',ownerUserId:owner},'bootstrap')).id;
  await setOrganizationEntitlement(opened.db,clock,developer,organizationId,{enabled:true},'bootstrap');
  integrationAccountId = (await createIntegrationAccount(opened.db,clock,owner,organizationId,{provider:'csv',externalAccountId:'scheduled-shipment-fixture'},'bootstrap')).id;
  operatorMembershipId = (await opened.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[organizationId,owner])).rows[0].id;
  objects = await mkdtemp(path.join(tmpdir(),'pp-shipment-originals-'));
  deps = {db:opened.db,clock,objectStore:new LocalObjectStore(objects,'http://127.0.0.1','fixture-only'),
    auth:new BearerUserAdapter(opened.db),devAuth:true,testFixtures:true,publicBaseUrl:'http://127.0.0.1',
    webhookConfig:{encryptionKey:Buffer.alloc(32,7).toString('base64'),allowedHosts:[]}};
  app = createServerApp({...deps,emailDelivery:new DisabledEmailDelivery()});
  if (loopback) {
    server = createServer(app);
    await new Promise<void>((resolve,reject) => server!.once('error',reject).listen(0,'127.0.0.1',resolve));
  }
}, 90000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
  await opened?.close();
  if(objects)await rm(objects,{recursive:true,force:true});
  vi.unstubAllEnvs();
});

it('reconciles first and recurring scheduled originals through scoped HTTP approvals and a reopened filesystem store',async()=>{
  // Supertest receives an already-bound loopback server. The default transport
  // exercises the same middleware on hosts that cannot open a TCP listener.
  const http = server ? supertest(server) : inProcess(app);
  const sourceName='Scheduled CSV Export Folder v1';
  let command=0;
  const human = () => ({Authorization:'Bearer '+owner,'Idempotency-Key':'human-command-'+(++command)});
  const enrollment=await http.post('/connect/enrollments').send({deviceName:'Synthetic Connect',version:'0.4.1'});
  expect(enrollment.status).toBe(201);
  const decided=await http.post('/me/records/agent-enrollments/'+enrollment.body.id+'/decision').set(human()).send({
    ...scope(),decision:'approve',comparisonCode:enrollment.body.comparisonCode,integrationAccountId,operatorMembershipId,locationId:null,sourceName});
  expect(decided.status).toBe(200);
  const redeemed=await http.post('/connect/enrollments/'+enrollment.body.id+'/redeem').send({redeemSecret:enrollment.body.redeemSecret});
  expect(redeemed.status).toBe(200); expect(redeemed.body.state).toBe('credential');
  const installationId=redeemed.body.installationId;
  const service={'Authorization':'Bearer '+redeemed.body.token,'PackProof-Merchant-Id':organizationId};
  const heartbeat=(extra:Record<string,unknown>={})=>http.post('/v1/partner/agent/heartbeat').set(service).send({version:'0.4.1',queueCount:0,...extra});
  const acknowledged=await heartbeat({enrollmentAcknowledged:true});
  expect(acknowledged.status).toBe(200);
  expect(acknowledged.body.capabilities.interpretationVersions).toContain(CSV_RULES.interpretation.version);
  const timestamp=clock.now().toISOString();
  const shipment=(id:string)=>'\uFEFFShipment ID,Description,Quantity,Shipment date,Unmapped source column\r\n'+id+',Pipe,10,'+timestamp+',original retained\r\n';
  const firstCsv=shipment('0007'), nextCsv=shipment('0008');
  const mapping={shipmentReference:'Shipment ID',itemTitle:'Description',quantity:'Quantity',shippedAt:'Shipment date'};
  const config={folderDigest:'a'.repeat(64),sourceName,integrationAccountId,operatorMembershipId,locationId:null,mapping,timeZone:'source-offset',importValidRows:false,offlineWindowHours:24,
    sourceContract:{schema:'packproof.scheduled-csv/v2',expectedHeaders:['Shipment ID','Description','Quantity','Shipment date','Unmapped source column'],exporterName:null,exporterVersion:null,
      expectedIntervalSeconds:null,backfillFrom:timestamp,rulesVersion:CSV_RULES.version,profileVersion:CSV_RULES.profile,interpretationVersion:CSV_RULES.interpretation.version,basedOnConfigRevision:0,
      analysisRevision:1,confirmedFields:[],historyPolicy:{mode:'selected_then_new',baselineSha256:'b'.repeat(64),observedAt:timestamp,initialFileName:'first.csv',initialFileSha256:sha256Hex(firstCsv)}}};
  const proposed=await http.post('/v1/partner/agent/config-proposals').set(service).send(config);expect(proposed.status).toBe(200);
  let revision=0, configSha:string|null=null;
  const action=(payload:Record<string,unknown>)=>http.post('/me/records/agent-installations/'+installationId+'/actions').set(human()).send({...scope(),configRevision:revision,configSha256:configSha,...payload});
  const preview=(csv:string,key:string)=>http.post('/v1/partner/imports/preview').set(service).set('Idempotency-Key',key).send({sourceName,integrationAccountId,operatorMembershipId,mapping,timeZone:'source-offset',csv});
  const denied=await preview(firstCsv,'before-source-approval');expect(denied.status).toBe(403);expect(denied.body.code).toBe("AGENT_AUTHORIZATION_REQUIRED");
  const approved=await action({action:'configure',proposalSha256:proposed.body.proposalSha256});expect(approved.status).toBe(200);
  revision=approved.body.configRevision;configSha=approved.body.configSha256;
  const receipts:string[]=[],records:string[]=[];
  for(const [i,csv] of [firstCsv,nextCsv].entries()){
    const offered=await preview(csv,'preview-'+i); expect(offered.status,offered.body.error?.code).toBe(201);
    const receipt=offered.body;receipts.push(receipt.id);
    expect(receipt.original).toMatchObject({sha256:sha256Hex(csv),byteSize:Buffer.byteLength(csv)});
    expect(receipt.interpretation).toMatchObject({outcome:'automatic',decisionId:receipt.id,configurationRevision:1,originalSha256:sha256Hex(csv),sourceId:installationId});
    const retry=await preview(csv,'preview-'+i);expect(retry.status).toBe(201);expect(retry.body.id).toBe(receipt.id);
    const commit=(key:string)=>http.post('/v1/partner/imports/'+receipt.id+'/commit').set(service).set('Idempotency-Key',key).send({previewVersion:receipt.previewVersion,importValidRows:false});
    if(i===0){
      expect((await commit('unapproved-first-batch')).body.code).toBe('AGENT_TEST_APPROVAL_REQUIRED');
      expect((await action({action:'authorize_test',importId:receipt.id})).status).toBe(200);
    }
    expect((await commit('commit-'+i)).status).toBe(202);
    const reopened=new LocalObjectStore(objects,'http://127.0.0.1','fixture-only');
    expect(await processPendingPartnerImports({...deps,objectStore:reopened})).toEqual({processed:1,failed:0});
    const fetched=await http.get('/v1/partner/imports/'+receipt.id).set(service);
    expect(fetched.status).toBe(200);expect(fetched.body.state).toBe('succeeded');expect(fetched.body.counts.imported).toBe(1);
    const recordId=fetched.body.recordIds[0];records.push(recordId);
    const record=await http.get('/v1/partner/proofs/'+recordId).set(service);
    expect(record.status).toBe(200);expect(record.body.proof.transaction).toMatchObject({itemTitle:'Pipe',quantity:10});
    const row=(await opened.db.query<{original_object_key:string;original_version_id:string}>('SELECT original_object_key,original_version_id FROM partner_import_jobs WHERE id=$1',[receipt.id])).rows[0];
    expect((await reopened.get(row.original_object_key,{versionId:row.original_version_id}))?.body).toEqual(Buffer.from(csv));
    if(i===0){
      expect((await action({action:'activate'})).body.code).toBe('VERIFICATION_REQUIRED');
      expect((await heartbeat({verifiedImportId:receipt.id})).status).toBe(200);
      const active=await action({action:'activate'});expect(active.status).toBe(200);expect(active.body.state).toBe('active');
    }
  }
  expect(new Set(receipts).size).toBe(2);expect(new Set(records).size).toBe(2);
  expect((await action({action:'revoke'})).status).toBe(200);
  const revoked=await preview(shipment('0009'),'revoked-source');expect(revoked.status).toBe(401);
  expect((await opened.db.query('SELECT id FROM partner_import_jobs WHERE agent_installation_id=$1',[installationId])).rows).toHaveLength(2);
  if (loopback && process.env.PACKPROOF_TEST_HTTP_TRACE) {
    const trace={transport:'loopback-http',listener:server!.address(),database:process.env.PACKPROOF_TEST_DATABASE_URL?'PostgreSQL':'PGlite',
      originalStore:'LocalObjectStore',receipts,records,originalSha256:[sha256Hex(firstCsv),sha256Hex(nextCsv)],revocationStatus:revoked.status,
      sourceApprovalStatus:approved.status,unauthorizedPreviewStatus:denied.status};
    await writeFile(process.env.PACKPROOF_TEST_HTTP_TRACE,JSON.stringify(trace,null,2)+'\n',{flag:'wx',mode:0o600});
  }
});
