import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {baselineStatements,scramVerifier,validateApplicationQualification,SOURCE,ROLES} from './records-runtime-roles.mjs';
const managed=Array.from({length:37},(_,i)=>'record_managed_'+i);
const state=()=>({tables:[{name:'users',privilege:'SELECT',allowed:true,grantable:false},{name:'schema_migrations',privilege:'SELECT',allowed:true,grantable:false},{name:'users',privilege:'TRIGGER',allowed:false,grantable:false}],columns:[{name:'proofs',column_name:'title',privilege:'UPDATE',allowed:true,table_allowed:false,grantable:false}],sequences:[{name:'legacy_sequence',privilege:'USAGE',allowed:true,grantable:false}],functions:[{name:'legacy_lock',arguments:'proof_id text',grantable:false}]});
test('baseline copy preserves explicit old rights while leaving managed authority to its existing planners',()=>{
 const sql=baselineStatements(state(),managed);
 for(const role of Object.values(ROLES)){
  assert(sql.includes('GRANT SELECT ON TABLE public."users" TO "'+role+'"'));
  assert(sql.includes('GRANT UPDATE("title") ON TABLE public."proofs" TO "'+role+'"'));
 }
 assert(!sql.some(s=>s.includes('WITH GRANT OPTION')||s.includes('ON ALL')||s.includes('DEFAULT PRIVILEGES')));
 assert(!sql.some(s=>s.includes('TRIGGER')||s.includes('record_managed_')||s.includes('integrity_envelope_results')));
});
const forbidden=[
 ['managed records table',s=>{s.tables[0].name=managed[0];}],
 ['managed M2 table',s=>{s.tables[0].name='recipient_export_jobs';}],
 ['migration writes',s=>{s.tables[1].privilege='UPDATE';}],
 ['system role writes',s=>{s.tables[0].name='user_system_roles';s.tables[0].privilege='INSERT';}],
 ['column control write',s=>{s.columns[0].name='schema_migrations';}],
 ['delegable grant',s=>{s.tables[0].grantable=true;}],
 ['trigger authority',s=>{s.tables[0].privilege='TRIGGER';}],
 ['truncate authority',s=>{s.tables[0].privilege='TRUNCATE';}],
 ['SQL table injection',s=>{s.tables[0].name='users; DROP TABLE users';}],
 ['SQL privilege injection',s=>{s.tables[0].privilege='SELECT; GRANT ALL';}],
 ['managed sequence',s=>{s.sequences[0].name='record_issue_actions_sequence_seq';}],
 ['sequence update authority',s=>{s.sequences[0].privilege='UPDATE';}],
 ['private records authority lock',s=>{s.functions[0].name='lock_operational_snapshot_authority';}],
 ['function argument injection',s=>{s.functions[0].arguments='text); DROP ROLE packproof';}],
];
for(const [name,mutate] of forbidden)test('rejects '+name,()=>{const s=state();mutate(s);assert.throws(()=>baselineStatements(s,managed),/^Error: RECORDS_/);});
test('requires the complete managed source inventory',()=>assert.throws(()=>baselineStatements(state(),managed.slice(1)),/INVENTORY_REQUIRED/));
test('SCRAM verifier never includes injected plaintext and enforces credential length',()=>{
 const password='fixture-only-password-for-verifier-test-0001';const verifier=scramVerifier(password,Buffer.alloc(24,1));
 assert.match(verifier,/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);assert(!verifier.includes(password));
 assert.throws(()=>scramVerifier('short'),/PASSWORD_REQUIRED/);
});
const body=()=>({schema:'packproof.records-inactive-app-live/v1',source:SOURCE,image:'784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api@sha256:6a396f672e62636a6fb603b7e922afadeed0070183d319e3ef335e9ac4274d6f',nativeStatus:'SUCCESSFUL',featureActivation:false,desired:1,running:1,pending:0,productionTraffic:100,taskDefinition:'arn:aws:ecs:us-east-1:784514617543:task-definition/packproof-v2-staging-cluster-packproof-v2-staging-api:51',completedAt:'2026-11-05T23:00:00Z',checks:[['/meta',200],['/health',200],['/ready',200],['/me/capabilities',401]].map(([route,status])=>({route,status,cors:'https://thepackproof.com'}))});
const envFor=b=>{const sha256=createHash('sha256').update(JSON.stringify(b)).digest('hex');return {PACKPROOF_RECORDS_APPLICATION_QUALIFIED_JSON:JSON.stringify({...b,sha256}),PACKPROOF_RECORDS_APPLICATION_QUALIFIED_SHA256:sha256};};
test('accepts a recent source/image-bound completed application rollout',()=>assert.match(validateApplicationQualification(envFor(body()),new Date('2026-11-05T23:01:00Z')),/^[a-f0-9]{64}$/));
for(const [name,change] of [['old bridge',b=>{b.image=b.image.replace('6a396f67','4302f878');}],['in-progress rollout',b=>{b.nativeStatus='IN_PROGRESS';}],['missing public auth proof',b=>{b.checks.pop();}],['early feature activation',b=>{b.featureActivation=true;}]])test('role activation rejects '+name,()=>{const b=body();change(b);assert.throws(()=>validateApplicationQualification(envFor(b),new Date('2026-11-05T23:01:00Z')),/^Error: RECORDS_/);});
test('role activation rejects expired evidence',()=>assert.throws(()=>validateApplicationQualification(envFor(body()),new Date('2026-11-07T23:01:00Z')),/EXPIRED/));
test('role activation rejects a changed report with the previous checksum',()=>{
 const env=envFor(body()),report=JSON.parse(env.PACKPROOF_RECORDS_APPLICATION_QUALIFIED_JSON);report.running=2;env.PACKPROOF_RECORDS_APPLICATION_QUALIFIED_JSON=JSON.stringify(report);assert.throws(()=>validateApplicationQualification(env,new Date('2026-11-05T23:01:00Z')),/BINDING_MISMATCH/);
});
