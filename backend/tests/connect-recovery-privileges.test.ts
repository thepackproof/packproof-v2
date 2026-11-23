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
import {migrationInventory} from '../src/db/migrate.js';
import {splitSqlStatements} from '../src/db/sql.js';
import {runRecoveryOwnerTransaction, recoveryInventory} from '../../infra/backend-release/recovery-hosted-migration.mjs';
import {recordsMigrationInventory, planRecordsRuntimePrivileges, verifyRecordsRuntimePrivileges,
  verifyPlannedRecordsPrivileges, type RecordsPrivilegeOptions} from '../scripts/records-runtime-privileges.mjs';

describe('Connect recovery under the actual restricted database callers', () => {
  const suffix=randomBytes(6).toString('hex'), source='a'.repeat(40), at='2026-11-23T16:00:00Z';
  const oldApi=`connect_api129_${suffix}`, oldWorker=`connect_worker129_${suffix}`;
  const api=`connect_api130_${suffix}`, worker=`connect_worker130_${suffix}`;
  const roles=[oldApi,oldWorker,api,worker];
  const org=`connect_org_${suffix}`, tenant=`connect_tenant_${suffix}`, member=`connect_member_${suffix}`;
  const configureOrg=`configure_org_${suffix}`,configureTenant=`configure_tenant_${suffix}`,configureMember=`configure_member_${suffix}`,configureSite=`configure_site_${suffix}`;
  const clock={now:()=>new Date(at)};
  let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>, ownerRole:string, human:string, w:RecordWorkspace,configureWorkspace:RecordWorkspace;
  let deps:AppDependencies, options129:RecordsPrivilegeOptions, options130:RecordsPrivilegeOptions;
  let configured:{id:string;principal:string;digest:string}, unassigned:{id:string;principal:string;digest:string};
  const reset=()=>opened.db.query(`SET SESSION AUTHORIZATION "${ownerRole.replace(/"/g,'""')}"`);
  const asRole=async<T>(role:string,fn:(db:Database)=>Promise<T>)=>{
    try { return await opened.db.transaction(async tx=>{
      await tx.query(`SET LOCAL SESSION AUTHORIZATION ${role}`);
      return fn(tx);
    }); } finally { await reset(); }
  };
  async function installation(name:string,organizationId=org,membershipId=member,locationId:string|null=null) {
    const id=`installation_${name}_${suffix}`, principal=`principal_${name}_${suffix}`;
    const credential=`credential_${name}_${suffix}`, account=`account_${name}_${suffix}`;
    const service=await insertUser(opened.db,clock);
    await opened.db.query("INSERT INTO platform_principals(id,organization_id,actor_user_id,name,created_at) VALUES($1,$2,$3,'Connect fixture',$4)",[principal,organizationId,service,at]);
    await opened.db.query("INSERT INTO platform_credentials(id,principal_id,token_hash,prefix,scopes,created_at,expires_at) VALUES($1,$2,$3,'fixture','[\"imports:read\"]',$4,$5)",[credential,principal,sha256Hex(credential),at,'2026-12-23T16:00:00Z']);
    await opened.db.query("INSERT INTO platform_integration_accounts(id,merchant_id,environment,provider,external_account_id,created_at) VALUES($1,$2,'sandbox','fixture',$3,$4)",[account,organizationId,name,at]);
    await opened.db.query(`INSERT INTO record_agent_installations(id,organization_id,environment,principal_id,credential_id,integration_account_id,operator_membership_id,location_id,source_name,device_name,version,approval_user_id,enrollment_expires_at,enrollment_acknowledged_at,created_at,updated_at)
      VALUES($1,$2,'sandbox',$3,$4,$5,$6,$9,'Scheduled CSV Export Folder v1','Recovery fixture','0.7.0',$7,$8,$8,$8,$8)`,[id,organizationId,principal,credential,account,membershipId,human,at,locationId]);
    const proposal={folderDigest:'a'.repeat(64),sourceName:'Scheduled CSV Export Folder v1',integrationAccountId:account,
      operatorMembershipId:membershipId,locationId,timeZone:'source-offset',importValidRows:false,offlineWindowHours:24,
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
    for(const [organizationId,tenantId,membershipId] of [[org,tenant,member],[configureOrg,configureTenant,configureMember]]){
      await opened.db.query("INSERT INTO api_tenants(id,owner_user_id,name,environment,created_at) VALUES($1,$2,$4,'sandbox',$3)",[tenantId,human,at,`Connect privilege ${tenantId}`]);
      await opened.db.query("INSERT INTO platform_organizations(id,kind,name,owner_user_id,environment,tenant_id,enabled,created_at) VALUES($1,'MERCHANT','Connect privilege fixture',$2,'sandbox',$3,true,$4)",[organizationId,human,tenantId,at]);
      await opened.db.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'OWNER',$4)",[membershipId,organizationId,human,at]);
    }
    await opened.db.query("INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,'Assigned configure facility',$3)",[configureSite,configureOrg,at]);
    w=await requireRecordWorkspace(opened.db,human,org,'sandbox',true);
    configureWorkspace=await requireRecordWorkspace(opened.db,human,configureOrg,'sandbox',true);
    deps={db:opened.db,clock,devAuth:true,testFixtures:true} as AppDependencies;
    configured=await installation('configure',configureOrg,configureMember,configureSite);unassigned=await installation('facility');
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
    const input={organizationId:configureOrg,environment:'sandbox',action:'configure',proposalSha256:configured.digest};
    await expect(asRole(oldApi,db=>actOnAgent(deps,db,configureWorkspace,configured.id,input,'reproduce-configure'))).rejects.toMatchObject({code:'42501'});
    expect(await loadInstallation(opened.db,configured.id)).toMatchObject({config_revision:0,approved_config:null,pending_proposal_sha256:configured.digest});
    const result=await asRole(api,db=>actOnAgent(deps,db,configureWorkspace,configured.id,input,'repair-configure'));
    expect(result).toMatchObject({state:'ready',configRevision:1,locationId:configureSite,configSha256:configured.digest,pendingProposal:null});
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

describe.skipIf(!process.env.PACKPROOF_TEST_DATABASE_URL)('PostgreSQL 16 Connect recovery owner qualification',()=>{
  it('rolls back the exact129→130 rehearsal, then applies only its reviewed grants and preserves predecessor receipts',async()=>{
    const opened=await openIsolatedTestDatabase(),suffix=randomBytes(6).toString('hex'),source='b'.repeat(40);
    const api=`recovery_owner_api_${suffix}`,worker=`recovery_owner_worker_${suffix}`,roles=[api,worker],created:string[]=[];
    const previous='8ab67cf9cc721d6da4c28cef72fdcdaf2b08faaa86196d76acff0a4f95f97fcc';
    const oldSource=process.env.PACKPROOF_RELEASE_SHA;
    let ownerRole='';
    const reset=()=>opened.db.query(`SET SESSION AUTHORIZATION "${ownerRole.replace(/"/g,'""')}"`);
    const asRole=async<T>(role:string,fn:(db:Database)=>Promise<T>)=>{
      try{return await opened.db.transaction(async tx=>{await tx.query(`SET LOCAL SESSION AUTHORIZATION ${role}`);return fn(tx);});}
      finally{await reset();}
    };
    try{
      process.env.PACKPROOF_RELEASE_SHA=source;
      await migrateTestDatabaseThrough(opened.db,129);
      const identity=(await opened.db.query<{role:string;database:string;schema:string;version:number}>(
        'SELECT current_user AS role,current_database() AS database,current_schema() AS schema,current_setting(\'server_version_num\')::integer AS version')).rows[0];
      ownerRole=identity.role;
      expect(identity.version).toBeGreaterThanOrEqual(160000);expect(identity.version).toBeLessThan(170000);
      for(const role of roles){
        await opened.db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
        created.push(role);
        await opened.db.query(`GRANT USAGE ON SCHEMA ${identity.schema} TO ${role}`);
        await opened.db.query(`GRANT SELECT(id,checksum) ON schema_migrations TO ${role}`);
        await opened.db.query(`GRANT SELECT(datname,datdba) ON pg_catalog.pg_database TO ${role}`);
      }
      const policy=async(throughMigration:129|130):Promise<RecordsPrivilegeOptions>=>({runtimeRole:api,workerRole:worker,
        schema:identity.schema,reviewedSourceCommit:source,throughMigration,
        reviewedMigrationSha256:(await recordsMigrationInventory(throughMigration)).migrationSha256});
      const policy129=await policy(129),policy130=await policy(130);
      for(const sql of (await planRecordsRuntimePrivileges(opened.db,policy129)).statements)await opened.db.query(sql);
      await opened.db.query('CREATE TABLE preserved_recovery_fixture(id integer PRIMARY KEY, original bytea NOT NULL)');
      await opened.db.query('INSERT INTO preserved_recovery_fixture(id,original) VALUES(1,$1)',[Buffer.from('retained original\r\nunchanged bytes')]);
      const ledger=async()=>(await opened.db.query('SELECT id,checksum,applied_at::text,checksum_provenance FROM schema_migrations ORDER BY id')).rows;
      const acl=async()=>(await opened.db.query<{relation:string;table_acl:string|null;columns:unknown}>(`SELECT c.relname AS relation,c.relacl::text AS table_acl,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('column',a.attname,'acl',a.attacl::text) ORDER BY a.attnum)
          FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb) AS columns
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema() AND c.relkind='r' ORDER BY c.relname`)).rows;
      const original=async()=>(await opened.db.query("SELECT encode(original,'hex') AS bytes FROM preserved_recovery_fixture ORDER BY id")).rows;
      const before={ledger:await ledger(),acl:await acl(),original:await original()};
      const review={source,apiRole:api,workerRole:worker,ownerRole,target:{database:identity.database},
        inventorySha256:recoveryInventory,expectedLedger:previous};
      const dependencies={migrationInventory,splitSqlStatements,planRecordsRuntimePrivileges,verifyPlannedRecordsPrivileges};
      const run=(mode:string)=>opened.db.transaction(tx=>runRecoveryOwnerTransaction(tx,review,mode,dependencies,identity.schema));
      expect(await run('inspect')).toMatchObject({through:129,initialLedger:previous,finalLedger:previous,applied:[],grantStatementCount:0});
      const rollback=Error('EXPECTED_CONNECT_RECOVERY_REHEARSAL_ROLLBACK');
      await expect(opened.db.transaction(async tx=>{
        const result=await runRecoveryOwnerTransaction(tx,review,'rehearse',dependencies,identity.schema);
        expect(result).toMatchObject({through:129,initialLedger:previous,finalLedger:recoveryInventory,
          applied:['130_connect_recovery_collector_version']});
        expect(result.grantStatementCount).toBeGreaterThan(0);
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await ledger()).toEqual(before.ledger);expect(await acl()).toEqual(before.acl);expect(await original()).toEqual(before.original);
      for(const role of roles)expect((await asRole(role,db=>verifyRecordsRuntimePrivileges(db,policy129))).caller).toBe(role);
      await expect(asRole(api,db=>db.query("UPDATE partner_import_jobs SET last_error_code='AGENT_CONFIGURATION_SUPERSEDED' WHERE false"))).rejects.toMatchObject({code:'42501'});

      const applied=await run('apply');
      expect(applied).toMatchObject({through:129,initialLedger:previous,finalLedger:recoveryInventory,
        applied:['130_connect_recovery_collector_version']});
      const after=await ledger(),afterAcl=await acl();
      expect(after.slice(0,before.ledger.length)).toEqual(before.ledger);
      expect(after.at(-1)).toMatchObject({id:'130_connect_recovery_collector_version',checksum_provenance:'EXECUTED_BYTES'});
      expect(after).toHaveLength(before.ledger.length+1);expect(await original()).toEqual(before.original);
      const changed=afterAcl.filter((row,index)=>JSON.stringify(row)!==JSON.stringify(before.acl[index])).map(row=>row.relation);
      expect(changed.sort()).toEqual(['partner_import_jobs','record_agent_installations','record_locations']);
      for(const role of roles)expect((await asRole(role,db=>verifyRecordsRuntimePrivileges(db,policy130))).caller).toBe(role);
      await asRole(api,db=>db.query("UPDATE partner_import_jobs SET state='action_needed',last_error_code='AGENT_CONFIGURATION_SUPERSEDED',updated_at=now() WHERE false"));
      await expect(asRole(worker,db=>db.query('UPDATE record_agent_installations SET location_id=location_id WHERE false'))).rejects.toMatchObject({code:'42501'});
      expect(await run('apply')).toMatchObject({through:130,initialLedger:recoveryInventory,finalLedger:recoveryInventory,applied:[],grantStatementCount:0});
      expect(await ledger()).toEqual(after);expect(await acl()).toEqual(afterAcl);expect(await original()).toEqual(before.original);
    }finally{
      if(ownerRole)await reset();
      for(const role of created){await opened.db.query(`DROP OWNED BY ${role}`);await opened.db.query(`DROP ROLE IF EXISTS ${role}`);}
      await opened.close();
      if(oldSource===undefined)delete process.env.PACKPROOF_RELEASE_SHA;else process.env.PACKPROOF_RELEASE_SHA=oldSource;
    }
  },90000);
});
