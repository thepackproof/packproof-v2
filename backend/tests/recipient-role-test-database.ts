import {randomBytes} from 'node:crypto';
import type {Database} from '../src/db/database.js';
import {createPgDatabase} from '../src/db/postgres.js';
import {grantIsolatedRecipientRoles} from '../scripts/isolated-recipient-grants.mjs';

/** Separate login sessions in the PostgreSQL gate; SET LOCAL ROLE for PGlite. */
export async function openRecipientTestRoles(owner:Database) {
 const suffix=randomBytes(8).toString('hex'),apiRole=`m2_recipient_api_${suffix}`,workerRole=`m2_recipient_worker_${suffix}`;
 const connection=process.env.PACKPROOF_TEST_DATABASE_URL;
 if(connection&&!['localhost','127.0.0.1','[::1]'].includes(new URL(connection).hostname))throw Error('Recipient role tests require loopback PostgreSQL');
 const schema=(await owner.query<{name:string}>('SELECT current_schema() AS name')).rows[0].name;
 if(!/^[a-z][a-z0-9_]+$/.test(schema))throw Error('Unsafe test schema');
 const sessions:Array<ReturnType<typeof createPgDatabase>>=[],created:string[]=[],passwords=new Map<string,string>();
 const close=async()=>{
  for(const session of sessions)await session.close();
  for(const role of created){await owner.query(`DROP OWNED BY ${role}`);await owner.query(`DROP ROLE ${role}`);}
 };
 try {
  for(const role of [apiRole,workerRole]){
   const password=randomBytes(32).toString('hex');passwords.set(role,password);
   await owner.query(`CREATE ROLE ${role} ${connection?'LOGIN':'NOLOGIN'} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);created.push(role);
  }
  await grantIsolatedRecipientRoles(owner,{apiRole,workerRole,purpose:'isolated-m2-synthetic'});
  function runtime(role:string):Database {
   if(connection){
    const url=new URL(connection);url.username=role;url.password=passwords.get(role)!;url.searchParams.set('options',`-c search_path=${schema}`);
    const session=createPgDatabase(url.toString());sessions.push(session);return session.db;
   }
   const transaction:Database['transaction']=fn=>owner.transaction(async tx=>{await tx.query(`SET LOCAL ROLE ${role}`);return fn(tx);});
   return {query:(sql,params)=>transaction(tx=>tx.query(sql,params)),transaction};
  }
  const api=runtime(apiRole),worker=runtime(workerRole);
  for(const [db,role] of [[api,apiRole],[worker,workerRole]] as const){
   const identity=(await db.query<{principal:string;session:string}>('SELECT current_user AS principal,session_user AS session')).rows[0];
   if(identity.principal!==role||(connection&&identity.session!==role))throw Error('Separate recipient role session required');
  }
  return {api,worker,apiRole,workerRole,close,engine:connection?'postgresql-logins':'pglite-local-roles'};
 }catch(error){await close();throw error;}
}
