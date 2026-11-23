import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import type {AppDependencies} from '../src/app.js';
import type {Database} from '../src/db/database.js';
import {insertUser} from '../src/domain/users.js';
import {canonicalize} from '../src/canonical.js';
import {sha256Hex} from '../src/hash.js';
import {CSV_RULES} from '../src/records/csv-semantics.js';
import {requireRecordWorkspace, type RecordWorkspace} from '../src/records/access.js';
import {actOnAgent, loadInstallation, validateAgentConfig} from '../src/records/agent-enrollments.js';
import {openIsolatedTestDatabase, migrateTestDatabaseThrough} from './isolated-test-database.js';
import {recordsMigrationInventory, planRecordsRuntimePrivileges, verifyRecordsRuntimePrivileges,
  type RecordsPrivilegeOptions} from '../scripts/records-runtime-privileges.mjs';

describe('Connect recovery under the actual restricted database callers', () => {
  const suffix=randomBytes(6).toString('hex'), source='a'.repeat(40), at='2026-11-23T16:00:00Z';
  const oldApi=`connect_api129_${suffix}`, oldWorker=`connect_worker129_${suffix}`;
  const api=`connect_api130_${suffix}`, worker=`connect_worker130_${suffix}`;
  const roles=[oldApi,oldWorker,api,worker];
  const org=`connect_org_${suffix}`, tenant=`connect_tenant_${suffix}`, member=`connect_member_${suffix}`;
  const clock={now:()=>new Date(at)};
  let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>, ownerRole:string, human:string, w:RecordWorkspace;
  let deps:AppDependencies, options129:RecordsPrivilegeOptions, options130:RecordsPrivilegeOptions;
  let configured:{id:string;principal:string;digest:string}, unassigned:{id:string;principal:string;digest:string};
  const reset=()=>opened.db.query(`SET SESSION AUTHORIZATION "${ownerRole.replace(/"/g,'""')}"`);
  const asRole=async<T>(role:string,fn:(db:Database)=>Promise<T>)=>{
    try { return await opened.db.transaction(async tx=>{
      await tx.query(`SET LOCAL SESSION AUTHORIZATION ${role}`);
      return fn(tx);
    }); } finally { await reset(); }
  };
  async function installation(name:string) {
    const id=`installation_${name}_${suffix}`, principal=`principal_${name}_${suffix}`;
    const credential=`credential_${name}_${suffix}`, account=`account_${name}_${suffix}`;
    const service=await insertUser(opened.db,clock);
    await opened.db.query("INSERT INTO platform_principals(id,organization_id,actor_user_id,name,created_at) VALUES($1,$2,$3,'Connect fixture',$4)",[principal,org,service,at]);
    await opened.db.query("INSERT INTO platform_credentials(id,principal_id,token_hash,prefix,scopes,created_at,expires_at) VALUES($1,$2,$3,'fixture','[\"imports:read\"]',$4,$5)",[credential,principal,sha256Hex(credential),at,'2026-12-23T16:00:00Z']);
    await opened.db.query("INSERT INTO platform_integration_accounts(id,merchant_id,environment,provider,external_account_id,created_at) VALUES($1,$2,'sandbox','fixture',$3,$4)",[account,org,name,at]);
    await opened.db.query(`INSERT INTO record_agent_installations(id,organization_id,environment,principal_id,credential_id,integration_account_id,operator_membership_id,location_id,source_name,device_name,version,approval_user_id,enrollment_expires_at,enrollment_acknowledged_at,created_at,updated_at)
      VALUES($1,$2,'sandbox',$3,$4,$5,$6,NULL,'Scheduled CSV Export Folder v1','Recovery fixture','0.7.0',$7,$8,$8,$8,$8)`,[id,org,principal,credential,account,member,human,at]);
    const proposal={folderDigest:'a'.repeat(64),sourceName:'Scheduled CSV Export Folder v1',integrationAccountId:account,
      operatorMembershipId:member,locationId:null,timeZone:'source-offset',importValidRows:false,offlineWindowHours:24,
      mapping:{shipmentReference:'Shipment reference',itemTitle:'Description',quantity:'Quantity',shippedAt:'Shipment date'},
      sourceContract:{schema:'packproof.scheduled-csv/v2',exporterName:null,exporterVersion:null,
        expectedHeaders:['Shipment reference','Description','Quantity','Shipment date'],expectedIntervalSeconds:null,
        backfillFrom:at,rulesVersion:CSV_RULES.version,profileVersion:CSV_RULES.profile,analysisRevision:1,confirmedFields:[],
        historyPolicy:{mode:'selected_then_new',baselineSha256:'b'.repeat(64),observedAt:at,initialFileName:'saved-report.csv',initialFileSha256:'c'.repeat(64)}}};
    const validated=validateAgentConfig(proposal,await loadInstallation(opened.db,id));
    const digest=sha256Hex(canonicalize(validated));
    await opened.db.query('UPDATE record_agent_installations SET pending_proposal=$2::jsonb,pending_proposal_sha256=$3 WHERE id=$1',[id,JSON.stringify(validated),digest]);
    return {id,principal,digest};
  }
  beforeAll(async()=>{
    vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');vi.stubEnv('PACKPROOF_RELEASE_SHA',source);
    opened=await openIsolatedTestDatabase();await migrateTestDatabaseThrough(opened.db,130);
    ownerRole=(await opened.db.query<{name:string}>('SELECT session_user AS name')).rows[0].name;
    const schema=(await opened.db.query<{name:string}>('SELECT current_schema() AS name')).rows[0].name;
    for(const role of roles){
      await opened.db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await opened.db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await opened.db.query(`GRANT SELECT(id,checksum) ON schema_migrations TO ${role}`);
      await opened.db.query(`GRANT SELECT(datname,datdba) ON pg_catalog.pg_database TO ${role}`);
    }
    for(const [throughMigration,runtimeRole,workerRole] of [[129,oldApi,oldWorker],[130,api,worker]] as const){
      const inventory=await recordsMigrationInventory(throughMigration);
      const options={runtimeRole,workerRole,schema,reviewedSourceCommit:source,reviewedMigrationSha256:inventory.migrationSha256,throughMigration};
      if(throughMigration===129)options129=options;else options130=options;
      const plan=await planRecordsRuntimePrivileges(opened.db,options);
      for(const sql of plan.statements)await opened.db.query(sql);
    }
    // Existing canonical/account and policy-journal grants are prerequisites,
    // separate from the column-scoped records profile under qualification.
    for(const role of [oldApi,api]){
      await opened.db.query(`GRANT SELECT ON users,platform_principals,platform_credentials,platform_integration_accounts,platform_organizations,platform_memberships,policy_recovery_fence,policy_recovery_tables,policy_recovery_events,policy_recovery_delivery TO ${role}`);
      await opened.db.query(`GRANT UPDATE(enabled) ON platform_organizations TO ${role}`);
      await opened.db.query(`GRANT UPDATE(revoked_at) ON platform_memberships TO ${role}`);
      await opened.db.query(`GRANT INSERT ON platform_action_audit,policy_recovery_events,policy_recovery_delivery TO ${role}`);
      await opened.db.query(`GRANT USAGE,SELECT ON SEQUENCE policy_recovery_events_sequence_seq TO ${role}`);
    }
    human=await insertUser(opened.db,clock);
    await opened.db.query("INSERT INTO api_tenants(id,owner_user_id,name,environment,created_at) VALUES($1,$2,'Connect privilege fixture','sandbox',$3)",[tenant,human,at]);
    await opened.db.query("INSERT INTO platform_organizations(id,kind,name,owner_user_id,environment,tenant_id,enabled,created_at) VALUES($1,'MERCHANT','Connect privilege fixture',$2,'sandbox',$3,true,$4)",[org,human,tenant,at]);
    await opened.db.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'OWNER',$4)",[member,org,human,at]);
    w=await requireRecordWorkspace(opened.db,human,org,'sandbox',true);
    deps={db:opened.db,clock,devAuth:true,testFixtures:true} as AppDependencies;
    configured=await installation('configure');unassigned=await installation('facility');
  },90000);
  afterAll(async()=>{
    vi.unstubAllEnvs();if(!opened)return;
    if(process.env.PACKPROOF_TEST_DATABASE_URL)for(const role of roles){await opened.db.query(`DROP OWNED BY ${role}`);await opened.db.query(`DROP ROLE ${role}`);}
    await opened.close();
  });

  it('reproduces the129 configure denial with zero imports and admits the exact SQL under130',async()=>{
    const sql="UPDATE partner_import_jobs SET state='action_needed',last_error_code='AGENT_CONFIGURATION_SUPERSEDED',updated_at=$2 WHERE principal_id=$1 AND state='previewed'";
    expect((await opened.db.query('SELECT id FROM partner_import_jobs WHERE principal_id=$1',[configured.principal])).rows).toHaveLength(0);
    await expect(asRole(oldApi,db=>db.query(sql,[configured.principal,at]))).rejects.toMatchObject({code:'42501'});
    expect((await asRole(api,db=>db.query(sql,[configured.principal,at]))).rowCount).toBe(0);
  });
  it('runs real scheduled-v2 configuration under130 after the same action fails under129',async()=>{
    const input={organizationId:org,environment:'sandbox',action:'configure',proposalSha256:configured.digest};
    await expect(asRole(oldApi,db=>actOnAgent(deps,db,w,configured.id,input,'reproduce-configure'))).rejects.toMatchObject({code:'42501'});
    expect(await loadInstallation(opened.db,configured.id)).toMatchObject({config_revision:0,approved_config:null,pending_proposal_sha256:configured.digest});
    const result=await asRole(api,db=>actOnAgent(deps,db,w,configured.id,input,'repair-configure'));
    expect(result).toMatchObject({state:'ready',configRevision:1,locationId:null,configSha256:configured.digest,pendingProposal:null});
    expect(result.config?.sourceContract?.historyPolicy?.initialFileSha256).toBe('c'.repeat(64));
  });
  it('performs explicit initial facility creation and binding with the existing recovery journal active',async()=>{
    const input={organizationId:org,environment:'sandbox',action:'connect_facility',configRevision:0,configSha256:null,
      proposalSha256:unassigned.digest,facilityName:'Recovery facility'};
    await expect(asRole(oldApi,db=>actOnAgent(deps,db,w,unassigned.id,input,'old-facility'))).rejects.toMatchObject({code:'42501'});
    const result=await asRole(api,db=>actOnAgent(deps,db,w,unassigned.id,input,'new-facility'));
    expect(result.locationId).toMatch(/^location_/);
    expect(result).toMatchObject({configRevision:0,config:null,pendingProposal:null});
    const journal=(await opened.db.query<{database_principal:string;after_json:{name:string}}>("SELECT database_principal,after_json FROM policy_recovery_events WHERE table_name='record_locations' AND entity_key->>'id'=$1",[result.locationId])).rows;
    expect(journal).toEqual([{database_principal:api,after_json:expect.objectContaining({name:'Recovery facility'})}]);
    await expect(asRole(worker,db=>db.query('UPDATE record_agent_installations SET location_id=$2 WHERE id=$1',[unassigned.id,result.locationId]))).rejects.toMatchObject({code:'42501'});
    await expect(asRole(worker,db=>db.query('INSERT INTO record_locations(id,organization_id,name,created_at) SELECT id,organization_id,name,created_at FROM record_locations WHERE false'))).rejects.toMatchObject({code:'42501'});
  });
  it('retains verified role separation and immutable source/evidence columns',async()=>{
    for(const [role,options] of [[oldApi,options129],[oldWorker,options129],[api,options130],[worker,options130]] as const)
      expect((await asRole(role,db=>verifyRecordsRuntimePrivileges(db,options))).caller).toBe(role);
    for(const role of [api,worker]){
      for(const column of ['original_sha256','original_object_key','original_version_id','mapping','principal_id','credential_id','agent_installation_id','agent_config_revision'])
        await expect(asRole(role,db=>db.query(`UPDATE partner_import_jobs SET ${column}=${column} WHERE false`))).rejects.toMatchObject({code:'42501'});
      await expect(asRole(role,db=>db.query('DELETE FROM partner_import_jobs WHERE false'))).rejects.toMatchObject({code:'42501'});
      await expect(asRole(role,db=>db.query('UPDATE record_locations SET organization_id=organization_id WHERE false'))).rejects.toMatchObject({code:'42501'});
    }
    await expect(asRole(api,db=>db.query('UPDATE record_agent_installations SET principal_id=principal_id WHERE false'))).rejects.toMatchObject({code:'42501'});
    await expect(asRole(worker,db=>db.query("UPDATE record_agent_installations SET status='ready' WHERE false"))).rejects.toMatchObject({code:'42501'});
  });
});
