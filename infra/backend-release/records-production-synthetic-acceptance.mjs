// Production HTTPS acceptance: synthetic sandbox records only.
// Service credentials are generated in memory, stored only as hashes, and revoked.
import {randomBytes,createHash} from 'node:crypto';
import {loadConfig} from '/app/backend/dist/config.js';
import {createPgDatabase} from '/app/backend/dist/db/postgres.js';
import {assertSchemaCurrent} from '/app/backend/dist/db/migrate.js';
import {newId} from '/app/backend/dist/ids.js';
const SOURCE=process.env.PACKPROOF_ACCEPTANCE_SOURCE;
const VERSION=process.env.PACKPROOF_ACCEPTANCE_VERSION;
const IMAGE=process.env.PACKPROOF_ACCEPTANCE_IMAGE;
const BASE='https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws';
const origin='https://thepackproof.com',run=newId('release_synthetic'),checks=[],fixtures=[];
const sha=v=>createHash('sha256').update(v).digest('hex');
let opened,phase='binding',seeded=false,cleanupVerified=false,passed=false;
function check(ok,code){if(!ok)throw Error(code);}
async function request(name,path,{token,body,method='GET',key,headers={},status=200}={}){
 const response=await fetch(BASE+path,{method,headers:{Origin:origin,...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
 const data=await response.json();
 const cors=response.headers.get('access-control-allow-origin');
 checks.push({name,status:response.status,cors,...(typeof data.code==='string'&&/^[A-Z0-9_]+$/.test(data.code)?{code:data.code}:{})});
 check(response.status===status,'HTTPS_STATUS_'+name.toUpperCase().replace(/[^A-Z0-9]/g,'_'));
 check(cors===origin,'HTTPS_CORS_REQUIRED');
 return {data,replayed:response.headers.get('idempotency-replayed')};
}
try{
 check(/^[a-f0-9]{40}$/.test(SOURCE??'')&&/^784514617543\.dkr\.ecr\.us-east-1\.amazonaws\.com\/packproof-v2-staging-api@sha256:[a-f0-9]{64}$/.test(IMAGE??'')&&VERSION==='records-api-2026.11.05-'+SOURCE.slice(0,8)&&process.env.PACKPROOF_RELEASE_SHA===SOURCE&&process.env.PACKPROOF_DB_USER==='packproof'&&process.env.PACKPROOF_OPERATOR_PURPOSE==='records-production-synthetic-acceptance','SYNTHETIC_OPERATOR_BINDING_REQUIRED');
 const meta=(await request('release-identity','/meta')).data;
 check(meta.commit===SOURCE&&meta.image===IMAGE&&meta.version===VERSION,'SYNTHETIC_LIVE_RELEASE_MISMATCH');
 await request('health','/health');await request('ready','/ready');
 await request('unauthenticated-partner','/v1/partner/limits',{status:401});
 const env=process.env,cfg=loadConfig({...env,DATABASE_URL:'',PACKPROOF_DB_SECRET_ARN:''}),url=new URL(cfg.databaseUrl);
 check(url.hostname==='packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com'&&url.pathname==='/packproof_v2'&&decodeURIComponent(url.username)==='packproof','SYNTHETIC_DATABASE_TARGET_REQUIRED');
 opened=createPgDatabase(url.toString(),undefined,env);
 const identity=(await opened.db.query('SELECT current_user AS role,session_user AS login,current_database() AS database')).rows[0];
 check(identity.role==='packproof'&&identity.login==='packproof'&&identity.database==='packproof_v2','SYNTHETIC_OWNER_IDENTITY_REQUIRED');
 await assertSchemaCurrent(opened.db);
 const scopes=['proofs:read','proofs:write','imports:read','imports:write','audit:read','events:read','exports:read','capture:request'];
 for(const label of ['A','B']){
  const f={label,owner:newId('synthetic_nonlogin'),actor:newId('synthetic_service'),tenant:newId('ten'),org:newId('org'),member:newId('member'),principal:newId('principal'),credential:newId('credential'),restrictedCredential:newId('credential'),token:'pp_org_sandbox_'+randomBytes(32).toString('base64url'),restrictedToken:'pp_org_sandbox_'+randomBytes(32).toString('base64url'),accounts:[newId('integration'),newId('integration'),newId('integration')]};
  fixtures.push(f);
 }
 phase='synthetic-seed';
 await opened.db.transaction(async db=>{
  const now=new Date().toISOString(),expires=new Date(Date.now()+15*60000).toISOString();
  for(const f of fixtures){
   for(const user of [f.owner,f.actor])await db.query('INSERT INTO users(id,created_at,updated_at) VALUES($1,$2,$2)',[user,now]);
   await db.query('INSERT INTO api_tenants(id,owner_user_id,name,environment,created_at) VALUES($1,$2,$3,$4,$5)',[f.tenant,f.owner,'SYNTHETIC RELEASE ACCEPTANCE '+run+' '+f.label,'sandbox',now]);
   await db.query("INSERT INTO platform_organizations(id,kind,name,owner_user_id,environment,tenant_id,enabled,created_at) VALUES($1,'MERCHANT',$2,$3,'sandbox',$4,true,$5)",[f.org,'SYNTHETIC RELEASE ACCEPTANCE '+run+' '+f.label,f.owner,f.tenant,now]);
   await db.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'OWNER',$4)",[f.member,f.org,f.owner,now]);
   await db.query('INSERT INTO platform_principals(id,organization_id,actor_user_id,name,created_at) VALUES($1,$2,$3,$4,$5)',[f.principal,f.org,f.actor,'SYNTHETIC NON-HUMAN RELEASE TEST',now]);
   for(const [id,token,allowed]of [[f.credential,f.token,scopes],[f.restrictedCredential,f.restrictedToken,['proofs:read']]]){
    await db.query('INSERT INTO platform_credentials(id,principal_id,token_hash,prefix,scopes,created_at,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)',[id,f.principal,sha(token),token.slice(0,22),JSON.stringify(allowed),now,expires]);
   }
   for(const [i,id]of f.accounts.entries())await db.query("INSERT INTO platform_integration_accounts(id,merchant_id,environment,provider,external_account_id,created_at) VALUES($1,$2,'sandbox','csv',$3,$4)",[id,f.org,run+':'+f.label+':'+i,now]);
   await db.query('INSERT INTO platform_action_audit(id,merchant_id,actor_user_id,request_id,operation,resource_id,policy_version,created_at) VALUES($1,$2,$3,$4,$5,$2,$6,$7)',[newId('org_audit'),f.org,f.owner,run,'RELEASE_SYNTHETIC_ACCEPTANCE_SEEDED','packproof.authorization/v1',now]);
  }
 });seeded=true;
 const [a,b]=fixtures,token=a.token,p='/v1/partner';
 phase='actual-api-permissions';
 await request('service-limits',p+'/limits',{token});
 const order={integrationAccountId:a.accounts[0],externalId:run+':order',operatorMembershipId:a.member,transaction:{itemTitle:'SYNTHETIC release test; no physical evidence',quantity:1}};
 const created=await request('order-create',p+'/proofs',{token,method:'POST',body:order,key:run+':order',status:201}),proofId=created.data.proofId;
 check(typeof proofId==='string'&&created.data.created===true,'SYNTHETIC_RECORD_CREATION_REQUIRED');
 const replay=await request('order-replay',p+'/proofs',{token,method:'POST',body:order,key:run+':order',status:201});
 check(replay.replayed==='true'&&replay.data.proofId===proofId,'SYNTHETIC_IDEMPOTENCY_REQUIRED');
 await request('order-conflict',p+'/proofs',{token,method:'POST',body:{...order,transaction:{...order.transaction,quantity:2}},key:run+':order',status:409});
 await request('restricted-write-denied',p+'/proofs',{token:a.restrictedToken,method:'POST',body:order,key:run+':restricted',status:403});
 const record=await request('record-read',p+'/proofs/'+proofId+'/record',{token});
 check(JSON.stringify(record.data).includes(proofId),'SYNTHETIC_RECORD_READ_BINDING_REQUIRED');
 await request('record-timeline',p+'/proofs/'+proofId+'/timeline',{token});
 await request('record-evidence',p+'/proofs/'+proofId+'/evidence',{token});
 await request('record-requirements',p+'/proofs/'+proofId+'/requirements',{token});
 await request('cross-merchant-read-denied',p+'/proofs/'+proofId+'/record',{token:b.token,status:404});
 await request('merchant-header-override-denied',p+'/proofs/'+proofId+'/record',{token,headers:{'PackProof-Merchant-Id':b.org},status:404});
 const page=await request('connections-page-one',p+'/connections?limit=1',{token}),cursor=page.data.nextCursor;
 check(page.data.hasMore===true&&typeof cursor==='string','SYNTHETIC_SIGNED_CURSOR_REQUIRED');
 const page2=await request('connections-page-two',p+'/connections?limit=1&cursor='+encodeURIComponent(cursor),{token});
 check(page2.data.connections[0].id!==page.data.connections[0].id,'SYNTHETIC_PAGINATION_DISTINCT_REQUIRED');
 await request('cursor-cross-merchant-denied',p+'/connections?limit=1&cursor='+encodeURIComponent(cursor),{token:b.token,status:400});
 await request('cursor-tamper-denied',p+'/connections?limit=1&cursor='+encodeURIComponent(cursor+'x'),{token,status:400});
 await request('audit-events',p+'/audit-events?limit=1',{token});
 await request('event-stream',p+'/event-stream?limit=1',{token});
 phase='sensitive-replay';
 const intentBody={allowedSurfaces:['WEB']},intentPath=p+'/proofs/'+proofId+'/capture-intents';
 const intent=await request('capture-intent',intentPath,{token,method:'POST',body:intentBody,key:run+':capture',status:201});
 check(intent.data.requiresAuthenticatedAttestation===true,'HUMAN_ATTESTATION_REQUIREMENT_REQUIRED');
 const intentReplay=await request('capture-intent-replay',intentPath,{token,method:'POST',body:intentBody,key:run+':capture',status:201});
 check(intentReplay.replayed==='true'&&JSON.stringify(intentReplay.data)===JSON.stringify(intent.data),'SYNTHETIC_SENSITIVE_REPLAY_REQUIRED');
 await request('service-attestation-denied',p+'/proofs/'+proofId+'/attestations',{token,method:'POST',body:{},key:run+':no-human',status:404});
 phase='csv-and-dedicated-worker';
 const csv='shipmentReference,itemTitle,quantity\n'+run+'-1,SYNTHETIC warehouse row one,2\n'+run+'-2,SYNTHETIC warehouse row two,3\n';
 const previewBody={integrationAccountId:a.accounts[0],operatorMembershipId:a.member,sourceName:'SYNTHETIC release acceptance; no physical evidence',csv,timeZone:'UTC'};
 const preview=await request('csv-preview',p+'/imports/preview',{token,method:'POST',body:previewBody,key:run+':preview',status:201});
 check(preview.data.counts.valid===2&&preview.data.original.sha256===sha(csv)&&preview.data.original.versionBound===true,'SYNTHETIC_CSV_PRESERVATION_REQUIRED');
 const previewReplay=await request('csv-preview-replay',p+'/imports/preview',{token,method:'POST',body:previewBody,key:run+':preview',status:201});
 check(previewReplay.replayed==='true'&&previewReplay.data.id===preview.data.id,'SYNTHETIC_CSV_REPLAY_REQUIRED');
 await request('restricted-import-denied',p+'/imports/preview',{token:a.restrictedToken,method:'POST',body:previewBody,key:run+':csv-denied',status:403});
 const commitPath=p+'/imports/'+preview.data.id+'/commit',commitBody={previewVersion:preview.data.previewVersion,importValidRows:false};
 await request('csv-commit',commitPath,{token,method:'POST',body:commitBody,key:run+':commit',status:202});
 const committedReplay=await request('csv-commit-replay',commitPath,{token,method:'POST',body:commitBody,key:run+':commit',status:202});
 check(committedReplay.replayed==='true','SYNTHETIC_COMMIT_REPLAY_REQUIRED');
 let completed;
 for(let attempt=0;attempt<45;attempt++){
  completed=(await request('csv-worker-poll',p+'/imports/'+preview.data.id,{token})).data;
  if(['succeeded','partially_succeeded','failed','action_needed'].includes(completed.state))break;
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
 check(completed?.state==='succeeded'&&completed.counts.imported===2&&completed.recordIds.length===2,'SYNTHETIC_DEDICATED_WORKER_IMPORT_REQUIRED');
 for(const id of completed.recordIds)await request('worker-created-record',p+'/proofs/'+id+'/record',{token});
 await request('foreign-import-denied',p+'/imports/'+preview.data.id,{token:b.token,status:404});
 checks.push({name:'worker-completion',state:completed.state,imported:completed.counts.imported,recordIds:completed.recordIds,originalSha256:preview.data.original.sha256,originalVersionBound:true});
 passed=true;
}catch(error){
 const code=/^[A-Z0-9_]{3,120}$/.test(error?.message??'')?error.message:'SYNTHETIC_ACCEPTANCE_REVIEW_REQUIRED';
 console.error(JSON.stringify({event:'records_production_synthetic_acceptance_failed',source:SOURCE,run,phase,code,checks}));process.exitCode=1;
}finally{
 if(opened&&seeded){
  try{
   const now=new Date().toISOString(),orgs=fixtures.map(f=>f.org),principals=fixtures.map(f=>f.principal),credentials=fixtures.flatMap(f=>[f.credential,f.restrictedCredential]);
   await opened.db.transaction(async db=>{
    await db.query('UPDATE platform_credentials SET revoked_at=COALESCE(revoked_at,$2) WHERE id=ANY($1::text[])',[credentials,now]);
    await db.query('UPDATE platform_principals SET revoked_at=COALESCE(revoked_at,$2) WHERE id=ANY($1::text[])',[principals,now]);
    await db.query('UPDATE platform_organizations SET enabled=false WHERE id=ANY($1::text[])',[orgs]);
    for(const f of fixtures)await db.query('INSERT INTO platform_action_audit(id,merchant_id,actor_user_id,request_id,operation,resource_id,policy_version,created_at) VALUES($1,$2,$3,$4,$5,$2,$6,$7)',[newId('org_audit'),f.org,f.owner,run,'RELEASE_SYNTHETIC_ACCEPTANCE_DISABLED','packproof.authorization/v1',now]);
   });
   const remaining=(await opened.db.query('SELECT (SELECT count(*) FROM platform_credentials WHERE id=ANY($1::text[]) AND revoked_at IS NULL)+(SELECT count(*) FROM platform_organizations WHERE id=ANY($2::text[]) AND enabled=true) AS n',[credentials,orgs])).rows[0];
   check(Number(remaining.n)===0,'SYNTHETIC_CLEANUP_REQUIRED');
   await request('credential-revoked','/v1/partner/limits',{token:fixtures[0].token,status:401});cleanupVerified=true;
  }catch{console.error(JSON.stringify({event:'records_production_synthetic_cleanup_failed',source:SOURCE,run}));process.exitCode=1;}
 }
 await opened?.close();
 console.log(JSON.stringify({event:'records_production_synthetic_acceptance',source:SOURCE,image:IMAGE,run,passed:passed&&cleanupVerified,cleanupVerified,environment:'sandbox',customerDataUsed:false,humanLoginImpersonated:false,physicalEvidenceClaimed:false,protectedFeaturesQualified:false,checks,syntheticOrganizations:fixtures.map(f=>f.org),completedAt:new Date().toISOString()}));
}
