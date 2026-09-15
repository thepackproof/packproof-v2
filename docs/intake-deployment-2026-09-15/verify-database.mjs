import {loadConfig} from '/app/dist/config.js';
import {openDatabase} from '/app/dist/db/open.js';
import {assertSchemaCurrent} from '/app/dist/db/migrate.js';
const config=loadConfig();
const opened=await openDatabase(config);
try {
  await assertSchemaCurrent(opened.db);
  const result=await opened.db.transaction(async db=>{
    await db.query('SET TRANSACTION READ ONLY');
    await db.query("SET LOCAL statement_timeout='15s'");
    const identity=(await db.query('SELECT current_user AS role,session_user AS login')).rows[0];
    const migrations=(await db.query('SELECT id,checksum,checksum_provenance FROM schema_migrations ORDER BY id')).rows;
    const temporaryRoles=(await db.query("SELECT rolname,rolvaliduntil FROM pg_roles WHERE rolname LIKE 'pp_intake_migrate_%' OR rolname LIKE 'pp_intake_probe_%'")).rows;
    const tables=(await db.query("SELECT tablename,tableowner FROM pg_tables WHERE schemaname='public' AND tablename IN ('intake_scoped_sessions','intake_submissions','commerce_sync_page_checkpoints') ORDER BY tablename")).rows;
    const permissions=(await db.query("SELECT t.tablename, p.privilege, has_table_privilege('packproof','public.'||t.tablename,p.privilege) AS allowed FROM (VALUES ('intake_scoped_sessions'),('intake_submissions'),('commerce_sync_page_checkpoints')) AS t(tablename) CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) AS p(privilege) ORDER BY t.tablename,p.privilege")).rows;
    const workers=(await db.query('SELECT DISTINCT ON (worker_name) worker_name,heartbeat_at,last_success_at,state FROM operational_worker_heartbeats ORDER BY worker_name,heartbeat_at DESC')).rows;
    const commerceAutomationConnections=(await db.query(`WITH connection_groups AS (
      SELECT c.provider,
             CASE WHEN c.provider IN ('shopify','etsy') THEN 'production'
                  WHEN a.provider_metadata->>'environment' IN ('production','sandbox') THEN a.provider_metadata->>'environment'
                  ELSE 'unknown' END AS environment,
             c.status,c.auto_sync_enabled
      FROM integration_connections AS c
      LEFT JOIN connected_accounts AS a ON a.id=c.id AND a.provider=c.provider
      WHERE c.provider IN ('ebay','shopify','etsy')
    )
    SELECT provider,environment,status,auto_sync_enabled,COUNT(*)::integer AS connection_count
    FROM connection_groups GROUP BY provider,environment,status,auto_sync_enabled
    ORDER BY provider,environment,status,auto_sync_enabled`)).rows;
    const durability=(await db.query('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows[0];
    return {checkedAt:new Date().toISOString(),identity,migrationCount:migrations.length,latestMigrations:migrations.slice(-2),temporaryRoles,temporaryLoginRemoved:temporaryRoles.length===0,tables,permissions,workers,commerceAutomationConnections,configuredAutoSyncConnectionsPausedByAllowlist:commerceAutomationConnections.filter(c=>c.status==='ACTIVE'&&c.auto_sync_enabled).reduce((n,c)=>n+c.connection_count,0),durability:{expected:config.requireDurableReceipts===true,actual:durability.durability_required,matches:durability.durability_required===(config.requireDurableReceipts===true)}};
  });
  console.log(JSON.stringify({event:'mobile_intake_deployment_verified',sourceSha:config.release.commit,...result}));
  if(result.temporaryRoles.length||result.migrationCount!==69||result.tables.length!==3||result.permissions.some(p=>p.allowed!==true)||!result.durability.matches||!result.workers.some(w=>w.worker_name==='mobile-intake'&&Date.now()-Date.parse(w.heartbeat_at)<120000&&w.state!=='ERROR'))process.exitCode=1;
}catch {console.log(JSON.stringify({event:'mobile_intake_deployment_verification_failed'}));process.exitCode=1;}
finally {await opened.close();}
