// Fixed, read-only facility metadata probe. This does not authenticate a person,
// grant access, enable a facility, or read customer originals/credential values.
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

const target = Object.freeze({
  repository:'784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api',
  taskPrefix:'arn:aws:ecs:us-east-1:784514617543:task/packproof-v2-staging-cluster/',
  host:'packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com',
  database:'packproof_v2',role:'packproof_records_api_v1',
});
const inventories = new Map([
  ['d0161362a548b61f4cc69195ad8920fbddec36f2b9d183e5b1cd066b6f0eeb60',123],
  ['8ab67cf9cc721d6da4c28cef72fdcdaf2b08faaa86196d76acff0a4f95f97fcc',128],
]);
const check = (ok,code) => {if(!ok) throw Error('FACILITY_INSPECT_'+code);};
const hex = (v,n) => typeof v==='string' && new RegExp(`^[a-f0-9]{${n}}$`).test(v);

export function inspectionInput(args,env) {
  const [source,inventory,subject]=args;
  const e=name=>env['PACKPROOF_'+name];
  check(args.length===3 && hex(source,40) && inventories.has(inventory) &&
    typeof subject==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(subject),'ARGUMENTS');
  const image=e('RELEASE_IMAGE');
  check(e('RELEASE_SHA')===source && typeof image==='string' &&
    image.startsWith(target.repository+'@sha256:') && hex(image.slice(target.repository.length+8),64),'IMAGE_SOURCE');
  check(e('ENVIRONMENT')==='production' && e('PROCESS_ROLE')==='api' &&
    e('MIGRATE_ON_START')==='false' && e('DB_HOST')===target.host &&
    e('DB_NAME')===target.database && e('DB_USER')===target.role &&
    (e('DB_PORT')??'5432')==='5432' && (e('DB_SSLMODE')??'verify-full')==='verify-full' &&
    ['/app/backend/certs/rds-us-east-1-bundle.pem','/app/certs/rds-us-east-1-bundle.pem'].includes(e('DB_CA_FILE')) &&
    typeof e('DB_PASSWORD')==='string' && e('DB_PASSWORD').length>0,'RUNTIME_CONNECTION');
  check(/^http:\/\/169\.254\.170\.2\/v4\/[A-Za-z0-9_-]+$/.test(env.ECS_CONTAINER_METADATA_URI_V4??''),'METADATA_URI');
  return {source,inventory,subject,image};
}

const identitySql = `SELECT ai.user_id,u.status,
 EXISTS(SELECT 1 FROM public.platform_principals p WHERE p.actor_user_id=ai.user_id) AS service_principal
 FROM public.auth_identities ai JOIN public.users u ON u.id=ai.user_id
 WHERE ai.provider='cognito' AND ai.provider_subject=$1 LIMIT 2`;
const facilitiesSql = `SELECT i.id AS installation_id,i.organization_id,
 i.environment,i.location_id,left(i.device_name,128) AS device_name,
 left(i.version,32) AS version,i.status,i.last_seen_at,o.enabled AS organization_enabled,
 m.role AS actor_role,(i.enrollment_acknowledged_at IS NOT NULL) AS enrollment_acknowledged,
 (i.renewal_credential_id IS NOT NULL) AS renewal_pending,(l.id IS NOT NULL) AS location_exists,
 (NOT m.location_scoped OR EXISTS(SELECT 1 FROM public.record_membership_locations g
  WHERE g.organization_id=i.organization_id AND g.location_id=i.location_id AND g.membership_id=m.id)) AS actor_location_allowed,
 count(*) OVER ()::text AS total_matching_installations
 FROM public.platform_memberships m JOIN public.platform_organizations o ON o.id=m.organization_id AND o.kind='MERCHANT'
 JOIN public.record_agent_installations i ON i.organization_id=o.id AND i.environment=o.environment
 LEFT JOIN public.record_locations l ON l.id=i.location_id AND l.organization_id=i.organization_id
 WHERE m.user_id=$1 AND m.revoked_at IS NULL AND m.role IN ('OWNER','ADMIN')
 ORDER BY i.last_seen_at DESC NULLS LAST,i.id LIMIT 21`;
const fields = ('installation_id organization_id environment location_id device_name version status last_seen_at '+
  'organization_enabled actor_role enrollment_acknowledged renewal_pending location_exists actor_location_allowed').split(' ');

export async function inspectFacilities(client,sub,inventory) {
  check(typeof sub==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sub) && inventories.has(inventory),'SUBJECT_OR_LEDGER');
  let begun=false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='2s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='10s'");
    const who=(await client.query(`SELECT current_user AS role,session_user AS login,current_database() AS database,
      current_setting('transaction_read_only') AS read_only,
      NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb) AS unprivileged,
      (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl FROM pg_roles r WHERE r.rolname=current_user`)).rows;
    check(who.length===1 && who[0].role===target.role && who[0].login===target.role && who[0].database===target.database &&
      who[0].read_only==='on' && who[0].ssl===true && who[0].unprivileged===true,'DATABASE_IDENTITY');
    const ledger=(await client.query('SELECT id,checksum FROM public.schema_migrations ORDER BY id LIMIT 129')).rows;
    check(ledger.length===inventories.get(inventory) &&
      createHash('sha256').update(JSON.stringify(ledger.map(({id,checksum})=>({id,checksum})))).digest('hex')===inventory,'LEDGER');
    const users=(await client.query(identitySql,[sub])).rows;
    check(users.length===1 && /^user_[A-Za-z0-9]{1,80}$/.test(users[0].user_id) &&
      users[0].status==='ACTIVE' && users[0].service_principal===false,'UNIQUE_ACTIVE_HUMAN');
    const userId=users[0].user_id,rows=(await client.query(facilitiesSql,[userId])).rows;
    const total=rows.length?Number(rows[0].total_matching_installations):0;
    check(rows.length<=21 && Number.isSafeInteger(total) && total>=rows.length &&
      rows.every(r=>Number(r.total_matching_installations)===total) &&
      new Set(rows.map(r=>r.installation_id)).size===rows.length,'INVENTORY_SHAPE');
    return {userId,totalMatchingInstallations:total,truncated:total>rows.length,
      installations:rows.map(row=>Object.fromEntries(fields.map(k=>[k,row[k]])))};
  } finally {
    // A failed rollback propagates; never produce a successful receipt without it.
    if(begun) await client.query('ROLLBACK');
  }
}

async function openRuntimeDatabase(env) {
  const {postgresPoolConfig}=await import('/app/backend/dist/db/postgres.js');
  const {Client}=createRequire('/app/backend/package.json')('pg');
  const uri=new URL('postgresql://'+target.host+':5432/'+target.database);
  uri.username=target.role;uri.searchParams.set('sslmode','verify-full');
  uri.searchParams.set('options','-c default_transaction_read_only=on');
  // No Secrets Manager client/provider: use only the execution role's injected value.
  const client=new Client(postgresPoolConfig(uri.href,async()=>env.PACKPROOF_DB_PASSWORD,env));
  try {await client.connect();return client;} catch(error) {await client.end();throw error;}
}

export async function runFacilityInspection({args=process.argv.slice(2),env=process.env,request=fetch,open=openRuntimeDatabase}={}) {
  const input=inspectionInput(args,env),uri=env.ECS_CONTAINER_METADATA_URI_V4;
  const metadata=async path=>{
    const response=await request(uri+path,{redirect:'error',signal:AbortSignal.timeout(5000)});
    check(response.ok,'METADATA_RESPONSE');return response.json();
  };
  const [container,task]=await Promise.all([metadata(''),metadata('/task')]);
  check(container?.Image===input.image && container?.ImageID===input.image.split('@')[1] &&
    typeof task?.TaskARN==='string' && task.TaskARN.startsWith(target.taskPrefix) &&
    hex(task.TaskARN.slice(target.taskPrefix.length),32),'TASK_IMAGE_CLUSTER');
  const client=await open(env);let inventory;
  try {inventory=await inspectFacilities(client,input.subject,input.inventory);} finally {await client.end();}
  return {schema:'packproof.logistics-facility-inspection/v1',readOnly:true,rolledBack:true,
    source:input.source,inventorySha256:input.inventory,image:input.image,actualTask:task.TaskARN,
    ...inventory,completedAt:new Date().toISOString()};
}

export async function facilityInspectionMain() {
  try {console.log(JSON.stringify(await runFacilityInspection()));}
  catch(error) {console.error(/^FACILITY_INSPECT_[A-Z_]+$/.test(error?.message)?error.message:'FACILITY_INSPECT_FAILED');process.exitCode=1;}
}
// The reviewed one-shot command explicitly invokes facilityInspectionMain().
