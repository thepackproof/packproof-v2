import { afterAll,expect,it } from 'vitest';
import { execFileSync,spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp,mkdir,mkdtemp,readFile,readdir,rm,symlink,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root=fileURLToPath(new URL('../../',import.meta.url)),backend=path.join(root,'backend');
let directory:string;
afterAll(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});
it('keeps the backend locked install independent of the parent application package',async()=>{
 const manifest=JSON.parse(await readFile(path.join(backend,'package.json'),'utf8')),lock=JSON.parse(await readFile(path.join(backend,'package-lock.json'),'utf8'));
 expect(Object.values(manifest.dependencies).some(value=>String(value).startsWith('file:'))).toBe(false);
 expect(lock.packages['..']).toBeUndefined();expect(lock.packages['node_modules/packproof-experience']).toBeUndefined();
 const docker=await readFile(path.join(backend,'Dockerfile'),'utf8');
 expect(docker.match(/^WORKDIR \/app\/backend$/gm)).toHaveLength(2);
 for(const line of ['COPY backend/package.json backend/package-lock.json ./','COPY backend/src ./src','COPY packages/evidence-contracts /app/packages/evidence-contracts','COPY config/rnd/research-build.json /app/config/rnd/research-build.json','COPY backend/migrations ./migrations','COPY backend/certs ./certs','COPY backend/rnd-openapi.json ./rnd-openapi.json','COPY backend/scripts/rnd-migrate.mjs ./scripts/rnd-migrate.mjs'])expect(docker).toContain(line);
 expect(docker).toContain('RUN npm ci --omit=dev');expect(docker).toContain('USER node');
 expect(docker).toContain('COPY backend/partner-openapi.json ./partner-openapi.json');
 expect(docker).toContain('COPY backend/claim-export-openapi.json ./claim-export-openapi.json');
 expect(docker).toContain('COPY backend/certs /app/certs'); // Preserve the live absolute CA-file binding.
});
it('keeps all 93 migration files byte-identical to the reviewed Git index with LF endings',async()=>{
 const files=(await readdir(path.join(backend,'migrations'))).filter(name=>name.endsWith('.sql')).sort();expect(files).toHaveLength(93);
 expect(files.at(-1)).toBe('094_claim_cases.sql');
 const output=execFileSync('git',['ls-files','--stage','--','backend/migrations'],{cwd:root,encoding:'utf8'});
 const indexed=new Map(output.trim().split(/\r?\n/).map(line=>{const found=/^100644 ([a-f0-9]{40}) 0\t(.+)$/.exec(line);if(!found)throw Error('Unmerged or unexpected migration index entry');return [found[2],found[1]];}));
 expect(indexed.size).toBe(93);
 for(const name of files){const bytes=await readFile(path.join(backend,'migrations',name)),gitBlob=execFileSync('git',['cat-file','blob',indexed.get('backend/migrations/'+name)!],{cwd:root});expect(bytes.includes(13),name).toBe(false);expect(createHash('sha256').update(bytes).digest('hex'),name).toBe(createHash('sha256').update(gitBlob).digest('hex'));}
},30_000);
it('imports the compiled server graph and resolves contracts, profile, migrations and scripts from the image layout',async()=>{
 directory=await mkdtemp(path.join(tmpdir(),'packproof-image-layout-'));const imageBackend=path.join(directory,'backend');await mkdir(imageBackend,{recursive:true});
 const compile=spawnSync(process.execPath,[path.join(backend,'node_modules/typescript/bin/tsc'),'--project',path.join(backend,'tsconfig.json'),'--outDir',path.join(imageBackend,'dist')],{cwd:backend,encoding:'utf8',timeout:25_000});
 expect(compile.status,compile.stdout+compile.stderr).toBe(0);
 await cp(path.join(root,'packages/evidence-contracts'),path.join(directory,'packages/evidence-contracts'),{recursive:true});
 await mkdir(path.join(directory,'config/rnd'),{recursive:true});await cp(path.join(root,'config/rnd/research-build.json'),path.join(directory,'config/rnd/research-build.json'));
 for(const name of ['migrations','certs','scripts'])await cp(path.join(backend,name),path.join(imageBackend,name),{recursive:true});
 await cp(path.join(backend,'certs'),path.join(directory,'certs'),{recursive:true});
 for(const name of ['package.json','package-lock.json','openapi.json','partner-openapi.json','claim-export-openapi.json','rnd-openapi.json'])await cp(path.join(backend,name),path.join(imageBackend,name));
 // Reuse the separately checked clean install; this is a path/import smoke check,
 // not a claim that Docker or AWS service initialization has run on this host.
 await symlink(path.join(backend,'node_modules'),path.join(imageBackend,'node_modules'),process.platform==='win32'?'junction':'dir');
 const script=`import './dist/server-app.js';
import {loadConfig} from './dist/config.js';
import {rndConfigFromEnv} from './dist/rnd/config.js';
import {assertResearchRuntimeIsolation} from './dist/rnd/runtime-isolation.js';
import {migrationInventory} from './dist/db/migrate.js';
import {sslConfigFromConnectionString} from './dist/db/postgres.js';
import {inspectInventory,PRODUCTION_RUNTIME_ROLE} from './scripts/rnd-migrate.mjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const env={NODE_ENV:'production',PACKPROOF_ENVIRONMENT:'staging',PACKPROOF_AUTH_MODE:'cognito',PACKPROOF_COGNITO_USER_POOL_ID:'synthetic-pool',PACKPROOF_COGNITO_CLIENT_ID:'synthetic-client',PACKPROOF_OBJECT_STORAGE:'s3',AWS_S3_BUCKET:'synthetic-bucket',DATABASE_URL:'postgres://synthetic:synthetic@database.invalid/packproof',PACKPROOF_RND_PROFILE:'capture-receipts-v1',PACKPROOF_RND_ENABLED:'1',PACKPROOF_RND_KILL_SWITCH:'0'};
assertResearchRuntimeIsolation(loadConfig(env),rndConfigFromEnv(env),env);
const tls=sslConfigFromConnectionString(env.DATABASE_URL,{...env,PACKPROOF_DB_CA_FILE:path.resolve('../certs/rds-us-east-1-bundle.pem')});if(tls?.rejectUnauthorized!==true||!String(tls.ca).includes('BEGIN CERTIFICATE'))throw Error('PRESERVED_ABSOLUTE_CA_PATH_UNAVAILABLE');
const inventory=await migrationInventory();
const reviewedResearchInventory=inventory.filter(row=>row.id<='087_rnd_source_storage_dedup');
inspectInventory(reviewedResearchInventory,reviewedResearchInventory);
let newerInventoryRefused=false;
try{inspectInventory(inventory,inventory);}catch(error){if(error.message!=='CANDIDATE_INVENTORY_MISMATCH')throw error;newerInventoryRefused=true;}
if(!newerInventoryRefused)throw Error('RETIRED_OPERATOR_ACCEPTED_UNREVIEWED_INVENTORY');
const partnerContract=JSON.parse(await readFile('partner-openapi.json','utf8'));
if(!partnerContract.paths['/v1/partner/event-stream']?.get)throw Error('PARTNER_CONTRACT_UNAVAILABLE');
const claimContract=JSON.parse(await readFile('claim-export-openapi.json','utf8'));
if(!claimContract.paths['/proofs/{id}/claim-cases']?.post)throw Error('CLAIM_CONTRACT_UNAVAILABLE');
await readFile('certs/rds-us-east-1-bundle.pem');
console.log(JSON.stringify({profile:'capture-receipts-v1',migrations:inventory.length,runtimeRole:PRODUCTION_RUNTIME_ROLE,serverImported:true}));`;
 await writeFile(path.join(imageBackend,'packaging-smoke.mjs'),script);
 const smoke=spawnSync(process.execPath,['packaging-smoke.mjs'],{cwd:imageBackend,encoding:'utf8',timeout:15_000,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,AWS_EC2_METADATA_DISABLED:'true'}});
 expect(smoke.status,smoke.stdout+smoke.stderr).toBe(0);expect(JSON.parse(smoke.stdout.trim())).toEqual({profile:'capture-receipts-v1',migrations:93,runtimeRole:'packproof_app_runtime_v1',serverImported:true});
},30_000);
it('leaves legacy builds/deployment inert before credentials, source uploads or cloud writes',async()=>{
 const build=await readFile(path.join(backend,'buildspec.yml'),'utf8');
 expect(build).toContain('on-failure: ABORT');expect(build).toMatch(/commands:\s*\n\s*- 'echo "LEGACY_BACKEND_BUILD_DISABLED:[^\n]+exit 2'/);
 expect(build).not.toMatch(/^\s*-.*(?:aws |docker |git )/m);
 const deploy=await readFile(path.join(root,'infra/deploy.ps1'),'utf8'),body=deploy.slice(deploy.indexOf('$ErrorActionPreference = "Stop"'));
 expect(body).toMatch(/^\$ErrorActionPreference = "Stop"\r?\nthrow "LEGACY_BACKEND_DEPLOY_DISABLED:/);
 const escaped=path.join(root,'infra/deploy.ps1').replace(/'/g,"''");
 const command=`$ErrorActionPreference='Stop'; function git { throw 'FORBIDDEN_GIT_CALL' }; function aws { throw 'FORBIDDEN_AWS_CALL' }; try { & '${escaped}' -ReviewedReleaseSha '${'a'.repeat(40)}'; exit 4 } catch { if ($_.Exception.Message.StartsWith('LEGACY_BACKEND_DEPLOY_DISABLED:')) { exit 0 }; Write-Error 'UNEXPECTED_DEPLOY_PATH'; exit 5 }`;
 const result=spawnSync(process.platform==='win32'?'powershell.exe':'pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{cwd:root,encoding:'utf8',timeout:15_000});
 expect(result.status,result.error?.message??result.stdout+result.stderr).toBe(0);
 const workflow=await readFile(path.join(root,'.github/workflows/deploy-staging.yml'),'utf8');
 expect(workflow).toContain('workflow_dispatch:');expect(workflow).not.toMatch(/^\s+(?:push|pull_request|schedule|workflow_run):/m);
});
