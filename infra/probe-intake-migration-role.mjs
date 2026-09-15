// Disposable PostgreSQL16 authority probe: every role operation is rolled back.
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export async function probeMigrationAuthority(db,quoteIdentifier){
  const fixture=`pp_intake_probe_${randomBytes(8).toString('hex')}`;
  const role=quoteIdentifier(fixture),owner=quoteIdentifier('packproof');
  let phase='identity',result;
  try{
    await db.transaction(async tx=>{
      await tx.query("SET LOCAL statement_timeout='15s'");await tx.query("SET LOCAL lock_timeout='5s'");
      const identity=(await tx.query('SELECT current_user AS role,session_user AS login')).rows[0];
      if(identity.role!=='packproof'||identity.login!=='packproof')throw Object.assign(new Error('OWNER_MISMATCH'),{safeCode:'OWNER_MISMATCH'});
      phase='create_fixture';
      await tx.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      const reverse=async()=>Number((await tx.query('SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE parent.rolname=$1 AND member.rolname=$2',[fixture,'packproof'])).rows[0].n);
      const reverseBefore=await reverse();
      if(reverseBefore){
        phase='remove_fixture_reverse_edge';
        await tx.query(`REVOKE ${role} FROM ${owner}`);
        if(await reverse())throw Object.assign(new Error('FIXTURE_REVERSE_EDGE_UNREMOVABLE'),{safeCode:'FIXTURE_REVERSE_EDGE_UNREMOVABLE'});
      }
      phase='grant_fixed_owner_to_fixture';
      await tx.query(`GRANT ${owner} TO ${role} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      const capability=(await tx.query("SELECT pg_has_role($1,$2,'SET') AS can_set",[fixture,'packproof'])).rows[0];
      if(capability?.can_set!==true)throw Object.assign(new Error('FIXTURE_SET_ROLE_UNAVAILABLE'),{safeCode:'FIXTURE_SET_ROLE_UNAVAILABLE'});
      phase='drop_fixture';await tx.query(`DROP ROLE ${role}`);
      if((await tx.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[fixture])).rows.length)throw Object.assign(new Error('FIXTURE_DROP_VERIFICATION_FAILED'),{safeCode:'FIXTURE_DROP_VERIFICATION_FAILED'});
      throw Object.assign(new Error('ROLLBACK_SUCCESSFUL_PROBE'),{probeResult:{supported:true,reverseMembershipCreated:reverseBefore>0,dropVerified:true}});
    });
    result={supported:false,phase:'rollback',code:'PROBE_UNEXPECTED_COMMIT'};
  }catch(error){result=error.probeResult??{supported:false,phase,code:error.safeCode??(/^[0-9A-Z]{5}$/.test(error.code??'')?error.code:'PROBE_FAILED')};}
  const remaining=(await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[fixture])).rows.length;
  if(remaining)throw Object.assign(new Error('PROBE_ROLLBACK_VERIFICATION_FAILED'),{safeCode:'PROBE_ROLLBACK_VERIFICATION_FAILED'});
  return{...result,rollbackVerified:true};
}

export async function main(){
  const [{loadConfig},{openDatabase},{default:pg}]=await Promise.all([import('/app/dist/config.js'),import('/app/dist/db/open.js'),import('/app/node_modules/pg/lib/index.js')]);
  const config=loadConfig();if(config.release.environment!=='staging')throw Error('ENVIRONMENT_MISMATCH');
  const opened=await openDatabase(config);
  try{console.log(JSON.stringify({event:'mobile_intake_role_authority_probe',...await probeMigrationAuthority(opened.db,pg.escapeIdentifier)}));}
  finally{await opened.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.log(JSON.stringify({event:'mobile_intake_role_authority_probe_failed'}));process.exitCode=1;});
