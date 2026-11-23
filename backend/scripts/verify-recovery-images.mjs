// Read-only image qualification. Exercise the compiled schema reader with the candidate's exact ledger.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inventorySha256, previousInventorySha256 } from './recovery-forward-guard.mjs';

const [predecessor,candidate,fallback] = process.argv.slice(2);
if (process.argv.length !== 5) throw Error('Supply three locally available image references.');
const docker = (args,input) => execFileSync('docker',args,{encoding:'utf8',input,maxBuffer:2*1024*1024});
const inspect = image => JSON.parse(docker(['image','inspect',image]))[0];
const run = (image,program) => docker(['run','--rm','-i','--network=none','--entrypoint','node',image,'--input-type=module','-'],program);
const before=inspect(predecessor), after=inspect(fallback);
assert.deepEqual(after.RootFS.Layers.slice(0,before.RootFS.Layers.length),before.RootFS.Layers);
for (const key of ['User','Cmd','Entrypoint','WorkingDir','Env','Healthcheck','ExposedPorts'])
  assert.deepEqual(after.Config[key],before.Config[key], 'Unexpected fallback configuration change to '+key);
const inventorySource=`import {migrationInventory} from './dist/db/migrate.js';
console.log(JSON.stringify((await migrationInventory()).map(({id,checksum})=>({id,checksum}))));`;
const read = image => JSON.parse(run(image,inventorySource));
const hash = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const older = read(predecessor), upgraded=read(candidate);
assert.equal(hash(older),previousInventorySha256);
assert.equal(hash(upgraded),inventorySha256);
assert.deepEqual(read(fallback),older);
run(candidate,"await import('/release/recovery-hosted-migration.mjs');");
function schema(ledger,pass) {
  return `import assert from 'node:assert/strict';
import {assertSchemaCurrent} from './dist/db/migrate.js';
const database = {query: async sql => {assert.match(sql,/^SELECT id,checksum FROM schema_migrations$/);return {rows:${JSON.stringify(ledger)}}}};
const verify = () => assertSchemaCurrent(database);
${pass?'await verify();':'await assert.rejects(verify);'}`;
}
run(predecessor,schema(older,true));
run(predecessor,schema(upgraded,false));
run(fallback,schema(older,true));
run(fallback,schema(upgraded,true));
run(candidate,schema(upgraded,true));
for (const image of [fallback,candidate]) {
  run(image,schema(upgraded.concat({id:'131_unreviewed',checksum:'0'.repeat(64)}),false));
  const altered=upgraded.map((row,i)=> i===128 ? {...row,checksum:'0'.repeat(64)} : row);
  run(image,schema(altered,false));
}
console.log(JSON.stringify({previousInventorySha256,inventorySha256,candidateReader:true,fallbackReader:true,
  originalRejectedNewLedger:true,unknownAndAlteredRejected:true,previousImageLayersPreserved:true}));
