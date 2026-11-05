import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {extendForwardCompatibility,BASE_MODULE_SHA256} from '../scripts/records-bridge-patch.mjs';
import {qualifiedRehearsal,run} from '../scripts/records-migrate-cli.mjs';
import {digest,INVENTORY_DIGEST} from '../scripts/records-migrate.mjs';

it('patches only the measured immutable bridge module and admits exact future receipts',async()=>{
 const fixture=await readFile(new URL('./fixtures/records-bridge-forward-compatible.js.txt',import.meta.url),'utf8');
 const manifest=JSON.parse(await readFile(new URL('../scripts/records-migration-manifest.json',import.meta.url),'utf8'));
 expect(createHash('sha256').update(fixture).digest('hex')).toBe(BASE_MODULE_SHA256);
 const extended=extendForwardCompatibility(fixture,manifest),module=await import('data:text/javascript;base64,'+Buffer.from(extended).toString('base64'));
 expect(module.FORWARD_COMPATIBLE_MIGRATIONS).toHaveLength(22);
 for(const row of manifest.additions){expect(module.isReviewedForwardCompatibleMigration(row)).toBe(true);expect(module.isReviewedForwardCompatibleMigration({...row,checksum:'0'.repeat(64)})).toBe(false);}
 expect(module.isReviewedForwardCompatibleMigration({id:'108_unreviewed',checksum:'0'.repeat(64)})).toBe(false);
 expect(()=>extendForwardCompatibility(fixture+'\n',manifest)).toThrow('RECORDS_BRIDGE_BASE_BYTES_MISMATCH');
 expect(()=>extendForwardCompatibility(fixture,{...manifest,inventorySha256:'0'.repeat(64)})).toThrow('RECORDS_BRIDGE_MANIFEST_MISMATCH');
 expect(()=>extendForwardCompatibility(fixture,{...manifest,additions:manifest.additions.map((row:any,i:number)=>i?row:{...row,checksum:'0'.repeat(64)})})).toThrow('RECORDS_BRIDGE_MANIFEST_MISMATCH');
});

it('rejects owner shortcuts or absent restored qualification before attempting a production connection',async()=>{
 await expect(run('--apply',{})).rejects.toThrow('RECORDS_EXPLICIT_OWNER_OPERATOR_REQUIRED');
 const env={PACKPROOF_DB_USER:'packproof',PACKPROOF_DB_PASSWORD:'synthetic-fixture',PACKPROOF_OPERATOR_PURPOSE:'records-inactive-production-migration',PACKPROOF_ENVIRONMENT:'production',PACKPROOF_MIGRATE_ON_START:'false',PACKPROOF_ORGANIZATIONS_ENABLED:'false',PACKPROOF_CLAIM_EXPORTS_ENABLED:'false'};
 await expect(run('--apply',env)).rejects.toThrow('RECORDS_REHEARSAL_REQUIRED');
 await expect(run('--apply',{...env,PACKPROOF_ORGANIZATIONS_ENABLED:'true'})).rejects.toThrow('RECORDS_INACTIVE_OPERATOR_CONFIGURATION_REQUIRED');
});

it('binds successful migration and bridge rehearsal evidence to exact source and a private restored database',()=>{
 const now=new Date('2026-11-05T12:00:00Z'),binding={source:'a'.repeat(40),compatibleImage:'sha256:'+'b'.repeat(64)};
 const body={schema:'packproof.records-release-rehearsal/v1',...binding,inventorySha256:INVENTORY_DIGEST,sourceDatabase:'packproof-v2-staging-db',restoredHost:'packproof-records-release-fixture.c8v2esku2zyt.us-east-1.rds.amazonaws.com',migrationExitCode:0,bridgeExitCode:0,baselinePreserved:true,runtimeAuthorityPreserved:true,taskArns:['1','2'].map(c=>'arn:aws:ecs:us-east-1:784514617543:task/packproof-v2-staging-cluster/'+c.repeat(32)),completedAt:now.toISOString()};
 const envFor=(value:typeof body)=>({PACKPROOF_RECORDS_REHEARSAL_JSON:JSON.stringify({...value,sha256:digest(value)}),PACKPROOF_RECORDS_REHEARSAL_SHA256:digest(value)});
 expect(qualifiedRehearsal(envFor(body),binding,now)).toBe(digest(body));
 expect(()=>qualifiedRehearsal(envFor({...body,bridgeExitCode:1}),binding,now)).toThrow('RECORDS_REHEARSAL_NOT_QUALIFIED');
 expect(()=>qualifiedRehearsal(envFor({...body,restoredHost:'packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com'}),binding,now)).toThrow('RECORDS_REHEARSAL_BINDING_MISMATCH');
 expect(()=>qualifiedRehearsal(envFor(body),{...binding,source:'c'.repeat(40)},now)).toThrow('RECORDS_REHEARSAL_BINDING_MISMATCH');
 expect(()=>qualifiedRehearsal(envFor(body),binding,new Date(now.getTime()+86400001))).toThrow('RECORDS_REHEARSAL_EXPIRED');
});
