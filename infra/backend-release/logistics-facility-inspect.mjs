import {createHash,createPublicKey,createPrivateKey,generateKeyPairSync,diffieHellman,hkdfSync,
  randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
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
  ['13f05713808a4c077b9388d5609d99ad1bfa16b9ded82b2e447bc1c076d5896e',129],
]);
const safeCode=Symbol();
const failure=code=>Object.defineProperty(Error(code),safeCode,{value:code});
const check=(ok,code)=>{if(!ok)throw failure('FACILITY_INSPECT_'+code);};
const hex = (v,n) => typeof v==='string' && new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const sha=value=>createHash('sha256').update(value).digest('hex');
const stages=new Set(('INPUT METADATA LOAD_MODULES CONFIGURATION CONNECT TRANSACTION IDENTITY LEDGER HUMAN '+
  'INSTALLATIONS ELIGIBLE_LOCATIONS ROLLBACK CLOSE ENCRYPT').split(' '));
export function formatFacilityInspectionFailure(error,stage='INPUT') {
  const sqlState=[error?.sqlState,error?.code].find(value=>typeof value==='string'&&/^[0-9A-Z]{5}$/.test(value));
  return {
  stage:stages.has(error?.stage)?error.stage:stages.has(stage)?stage:'INPUT',
  code:error?.[safeCode]??(sqlState?'POSTGRES_ERROR':'FACILITY_INSPECT_FAILED'),
  ...(sqlState?{sqlState}:{})};
}
function stagedFailure(error,stage) {
  const detail=formatFacilityInspectionFailure(error,stage),safe=failure(detail.code);
  safe.stage=detail.stage;if(detail.sqlState)safe.sqlState=detail.sqlState;return safe;
}
const decode=(value,limit)=>{check(typeof value==='string'&&value.length<=limit&&/^[A-Za-z0-9+/]*={0,2}$/.test(value),'ENVELOPE_ENCODING');
  const bytes=Buffer.from(value,'base64');check(bytes.toString('base64')===value,'ENVELOPE_ENCODING');return bytes;};
function recipientKey(encoded) {
  const bytes=decode(encoded,64);check(bytes.length===44,'RECIPIENT_KEY');
  const key=createPublicKey({key:bytes,format:'der',type:'spki'});check(key.asymmetricKeyType==='x25519','RECIPIENT_KEY');
  return key;
}
export {recipientKey as validateFacilityRecipientKey};
export function facilityEnvelopeHeader(envelope) {
  check(envelope?.schema==='packproof.logistics-facility-encrypted/v1'&&
    Object.keys(envelope).sort().join(',')==='ciphertext,protected,schema,tag','ENVELOPE_SHAPE');
  const bytes=decode(envelope.protected,8192),header=JSON.parse(bytes.toString('utf8'));
  check(header?.schema==='packproof.facility-encryption/v1'&&hex(header.subjectSha256,64)&&hex(header.recipientSha256,64)&&
    Object.keys(header).sort().join(',')==='actualTask,completedAt,ephemeralPublicKeySpki,image,inventorySha256,iv,recipientSha256,salt,schema,source,subjectSha256','ENVELOPE_HEADER');
  recipientKey(header.ephemeralPublicKeySpki);
  check(decode(header.salt,44).length===32&&decode(header.iv,16).length===12&&decode(envelope.tag,24).length===16,'ENVELOPE_PARAMETERS');
  decode(envelope.ciphertext,256000);return header;
}
export function encryptFacilityReceipt(report,subjectSha256,recipientPublicKeySpki) {
  check(hex(subjectSha256,64),'SUBJECT_DIGEST');
  const recipient=recipientKey(recipientPublicKeySpki),ephemeral=generateKeyPairSync('x25519');
  const salt=randomBytes(32),iv=randomBytes(12);
  const header={schema:'packproof.facility-encryption/v1',source:report.source,image:report.image,inventorySha256:report.inventorySha256,
    actualTask:report.actualTask,completedAt:report.completedAt,subjectSha256,recipientSha256:sha(decode(recipientPublicKeySpki,64)),
    ephemeralPublicKeySpki:ephemeral.publicKey.export({type:'spki',format:'der'}).toString('base64'),salt:salt.toString('base64'),iv:iv.toString('base64')};
  const aad=Buffer.from(JSON.stringify(header)),shared=diffieHellman({privateKey:ephemeral.privateKey,publicKey:recipient});
  const key=Buffer.from(hkdfSync('sha256',shared,salt,Buffer.from('packproof.facility-encryption/v1'),32));
  const plain=Buffer.from(JSON.stringify(report));check(plain.length<=192000,'RECEIPT_SIZE');
  try {
    const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);
    const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
    return {schema:'packproof.logistics-facility-encrypted/v1',protected:aad.toString('base64'),
      ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
  } finally {shared.fill(0);key.fill(0);plain.fill(0);}
}
export function decryptFacilityReceipt(envelope,privateKey,expected) {
  const header=facilityEnvelopeHeader(envelope),recipient=createPrivateKey(privateKey);
  check(recipient.asymmetricKeyType==='x25519'&&sha(createPublicKey(recipient).export({type:'spki',format:'der'}))===header.recipientSha256,'RECIPIENT_KEY');
  for(const name of ['source','image','inventorySha256','actualTask','subjectSha256'])check(typeof expected?.[name]==='string'&&header[name]===expected[name],'ENVELOPE_BINDING');
  const shared=diffieHellman({privateKey:recipient,publicKey:recipientKey(header.ephemeralPublicKeySpki)});
  const key=Buffer.from(hkdfSync('sha256',shared,decode(header.salt,44),Buffer.from('packproof.facility-encryption/v1'),32));
  try {
    const cipher=createDecipheriv('aes-256-gcm',key,decode(header.iv,16));cipher.setAAD(decode(envelope.protected,8192));cipher.setAuthTag(decode(envelope.tag,24));
    const plain=Buffer.concat([cipher.update(decode(envelope.ciphertext,256000)),cipher.final()]);
    const report=JSON.parse(plain.toString('utf8'));plain.fill(0);
    check(report?.schema==='packproof.logistics-facility-inspection/v1'&&report.readOnly===true&&report.rolledBack===true,'DECRYPTED_RECEIPT');
    for(const name of ['source','image','inventorySha256','actualTask','completedAt'])check(report[name]===header[name],'DECRYPTED_BINDING');
    return report;
  } finally {shared.fill(0);key.fill(0);}
}
export function inspectionInput(args,env) {
  const [source,inventory,subject,recipientPublicKeySpki]=args;
  const encrypted=args.length===4;
  const e=name=>env['PACKPROOF_'+name];
  check((args.length===3||encrypted) && hex(source,40) && inventories.has(inventory) &&
    (encrypted?hex(subject,64):typeof subject==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(subject)),'ARGUMENTS');
  if(encrypted)recipientKey(recipientPublicKeySpki);
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
  return {source,inventory,...(encrypted?{subjectSha256:subject,recipientPublicKeySpki}:{subject}),image};
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
const eligibleLocationsSql = `SELECT l.id AS eligible_location_id,left(l.name,120) AS location_name,
 count(*) OVER ()::text AS total_eligible_locations
 FROM public.record_agent_installations i
 JOIN public.platform_organizations o ON o.id=i.organization_id AND o.environment=i.environment AND o.kind='MERCHANT' AND o.enabled
 JOIN public.platform_memberships actor ON actor.organization_id=o.id AND actor.user_id=$1
  AND actor.revoked_at IS NULL AND actor.role IN ('OWNER','ADMIN')
 JOIN public.platform_memberships operator ON operator.id=i.operator_membership_id AND operator.organization_id=o.id
  AND operator.revoked_at IS NULL AND operator.role IN ('OWNER','ADMIN','OPERATOR')
 JOIN public.users teammate ON teammate.id=operator.user_id AND teammate.status='ACTIVE'
 JOIN public.record_locations l ON l.organization_id=o.id
 WHERE i.id=$2 AND i.organization_id=$3 AND i.environment=$4
 AND (NOT actor.location_scoped OR EXISTS(SELECT 1 FROM public.record_membership_locations g
  WHERE g.organization_id=o.id AND g.location_id=l.id AND g.membership_id=actor.id))
 AND (NOT operator.location_scoped OR EXISTS(SELECT 1 FROM public.record_membership_locations g
  WHERE g.organization_id=o.id AND g.location_id=l.id AND g.membership_id=operator.id))
 ORDER BY l.name,l.id LIMIT 21`;
function facilityFlags(env,organization,environment,location) {
  const scope=[organization,environment,location].join(':');
  const enabled=name=>typeof env[name]==='string' && env[name].split(',').some(value=>value.trim()===scope);
  const guided=!!location && env.PACKPROOF_ORDER_WORKSPACE_ENABLED==='true' && enabled('PACKPROOF_GUIDED_FACILITIES');
  return {guidedSetupAvailable:guided,assistantSetupAvailable:guided && enabled('PACKPROOF_SETUP_AI_FACILITIES')};
}
export async function inspectFacilities(client,sub,inventory,env={},hashedSubject=false) {
  let begun=false,stage='INPUT';
  try {
    check((hashedSubject?hex(sub,64):typeof sub==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sub)) && inventories.has(inventory),'SUBJECT_OR_LEDGER');
    stage='TRANSACTION';
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='2s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='10s'");
    stage='IDENTITY';
    const who=(await client.query(`SELECT current_user AS role,session_user AS login,current_database() AS database,
      current_setting('transaction_read_only') AS read_only,
      NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb) AS unprivileged,
      (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl FROM pg_roles r WHERE r.rolname=current_user`)).rows;
    check(who.length===1 && who[0].role===target.role && who[0].login===target.role && who[0].database===target.database &&
      who[0].read_only==='on' && who[0].ssl===true && who[0].unprivileged===true,'DATABASE_IDENTITY');
    stage='LEDGER';const ledger=(await client.query('SELECT id,checksum FROM public.schema_migrations ORDER BY id LIMIT 130')).rows;
    check(ledger.length===inventories.get(inventory) &&
      createHash('sha256').update(JSON.stringify(ledger.map(({id,checksum})=>({id,checksum})))).digest('hex')===inventory,'LEDGER');
    stage='HUMAN';const identity=hashedSubject?identitySql.replace('ai.provider_subject=$1',"encode(sha256(convert_to(ai.provider_subject,'UTF8')),'hex')=$1"):identitySql;
    const users=(await client.query(identity,[sub])).rows;
    check(users.length===1 && /^user_[A-Za-z0-9]{1,80}$/.test(users[0].user_id) &&
      users[0].status==='ACTIVE' && users[0].service_principal===false,'UNIQUE_ACTIVE_HUMAN');
    stage='INSTALLATIONS';const userId=users[0].user_id,rows=(await client.query(facilitiesSql,[userId])).rows;
    const total=rows.length?Number(rows[0].total_matching_installations):0;
    check(rows.length<=21 && Number.isSafeInteger(total) && total>=rows.length &&
      rows.every(r=>Number(r.total_matching_installations)===total) &&
      new Set(rows.map(r=>r.installation_id)).size===rows.length,'INVENTORY_SHAPE');
    const installations=[];
    for(const row of rows) {
      stage='ELIGIBLE_LOCATIONS';
      const locations=(await client.query(eligibleLocationsSql,[userId,row.installation_id,row.organization_id,row.environment])).rows;
      const count=locations.length?Number(locations[0].total_eligible_locations):0;
      check(locations.length<=21 && Number.isSafeInteger(count) && count>=locations.length &&
        locations.every(value=>Number(value.total_eligible_locations)===count && typeof value.eligible_location_id==='string' &&
          /^[A-Za-z0-9_-]{1,128}$/.test(value.eligible_location_id) && typeof value.location_name==='string' && value.location_name.length<=120) &&
        new Set(locations.map(value=>value.eligible_location_id)).size===locations.length,'LOCATIONS_SHAPE');
      installations.push({...Object.fromEntries(fields.map(k=>[k,row[k]])),
        ...facilityFlags(env,row.organization_id,row.environment,row.location_id),
        totalEligibleLocations:count,eligibleLocationsTruncated:count>locations.length,
        eligibleLocations:locations.map(value=>({id:value.eligible_location_id,name:value.location_name,
          ...facilityFlags(env,row.organization_id,row.environment,value.eligible_location_id)}))});
    }
    return {userId,totalMatchingInstallations:total,truncated:total>rows.length,installations};
  } catch(error) {throw stagedFailure(error,stage);} finally {
    if(begun)try{await client.query('ROLLBACK');}catch(error){throw stagedFailure(error,'ROLLBACK');}
  }
}
async function openRuntimeDatabase(env) {
  let stage='LOAD_MODULES';
  try {
  const {postgresPoolConfig}=await import('file:///app/backend/dist/db/postgres.js');
  const {Client}=createRequire('/app/backend/package.json')('pg');
  stage='CONFIGURATION';
  const uri=new URL('postgresql://'+target.host+':5432/'+target.database);
  uri.username=target.role;uri.searchParams.set('sslmode','verify-full');
  uri.searchParams.set('options','-c default_transaction_read_only=on');
  const client=new Client(postgresPoolConfig(uri.href,async()=>env.PACKPROOF_DB_PASSWORD,env));
  stage='CONNECT';
  try {await client.connect();return client;} catch(error) {
    try{await client.end();}catch(close){throw stagedFailure(close,'CLOSE');}throw error;
  }
  } catch(error) {throw stagedFailure(error,stage);}
}
export async function runFacilityInspection({args=process.argv.slice(2),env=process.env,request=fetch,open=openRuntimeDatabase}={}) {
  let stage='INPUT';
  try {
  const input=inspectionInput(args,env),uri=env.ECS_CONTAINER_METADATA_URI_V4;
  stage='METADATA';
  const metadata=async path=>{
    const response=await request(uri+path,{redirect:'error',signal:AbortSignal.timeout(5000)});
    check(response.ok,'METADATA_RESPONSE');return response.json();
  };
  const [container,task]=await Promise.all([metadata(''),metadata('/task')]);
  check(container?.Image===input.image && container?.ImageID===input.image.split('@')[1] &&
    typeof task?.TaskARN==='string' && task.TaskARN.startsWith(target.taskPrefix) &&
    hex(task.TaskARN.slice(target.taskPrefix.length),32),'TASK_IMAGE_CLUSTER');
  stage='CONNECT';const client=await open(env);let inventory;
  try {inventory=await inspectFacilities(client,input.subjectSha256??input.subject,input.inventory,env,!!input.subjectSha256);}
  finally {try{await client.end();}catch(error){throw stagedFailure(error,'CLOSE');}}
  const report={schema:'packproof.logistics-facility-inspection/v1',readOnly:true,rolledBack:true,
    source:input.source,inventorySha256:input.inventory,image:input.image,actualTask:task.TaskARN,
    ...inventory,completedAt:new Date().toISOString()};
  stage='ENCRYPT';return input.subjectSha256?encryptFacilityReceipt(report,input.subjectSha256,input.recipientPublicKeySpki):report;
  } catch(error) {throw stagedFailure(error,stage);}
}
export async function facilityInspectionMain(options) {
  try {console.log(JSON.stringify(await runFacilityInspection(options)));}
  catch(error) {console.error(JSON.stringify(formatFacilityInspectionFailure(error)));process.exitCode=1;}
}
