import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '../../backend/node_modules/@electric-sql/pglite/dist/index.js';
import {probeMigrationAuthority} from '../probe-intake-migration-role.mjs';

test('real PostgreSQL role graph fails closed for ordinary CREATEROLE and rolls back fixture',async()=>{
  const pg=new PGlite();
  try{
    await pg.exec('CREATE ROLE packproof LOGIN CREATEROLE; SET SESSION AUTHORIZATION packproof;');
    const db={query:(sql,params)=>pg.query(sql,params),transaction:work=>pg.transaction(tx=>work({query:(sql,params)=>tx.query(sql,params)}))};
    const result=await probeMigrationAuthority(db,name=>'"'+name.replaceAll('"','""')+'"');
    assert.equal(result.supported,false);assert.equal(result.rollbackVerified,true);
    assert.equal((await pg.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'pp_intake_probe_%'")).rows.length,0);
    assert.equal((await pg.query('SELECT current_user AS role')).rows[0].role,'packproof');
  }finally{await pg.close();}
});
