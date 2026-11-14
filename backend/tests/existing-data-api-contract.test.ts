import {describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {parseTypedSourceBatch} from '../src/records/source-contracts.js';

describe('published existing-data candidate developer contract',()=>{
 it('executes both documented original constructions through the actual intake parser',async()=>{
  const guide=await readFile(new URL('../../docs/EXISTING_DATA_API.md',import.meta.url),'utf8'),blocks=[...guide.matchAll(/```js\n([\s\S]*?)\n```/g)].map(m=>m[1]);expect(blocks).toHaveLength(2);
  const construct=(code:string,name:string)=>vm.runInNewContext(`${code.replace("import { createHash } from 'node:crypto';",'')}\n${name}`,{createHash});
  const json=construct(blocks[0],'jsonBatch'),first=parseTypedSourceBatch(json);expect(first.rows).toHaveLength(1);expect(first.rows[0].errors).toEqual([]);expect(first.rows[0].normalized?.references.find(r=>r.type==='order_line')).toMatchObject({externalId:'004',parentExternalId:'0010482'});
  const jsonV2=parseTypedSourceBatch({...json,schema:'packproof.typed-source-batch/v2',identityPolicy:{schema:'packproof.source-identity-policy/v1',eventKey:{kind:'column'},revision:{kind:'column'}}});expect(jsonV2.rows[0].errors).toEqual([]);
  const csv=parseTypedSourceBatch(construct(blocks[1],'csvBatch'));expect(csv.rows[0].errors).toEqual([]);expect(csv.rows[0].normalized).toMatchObject({sourceRevision:'snapshot:2026-11-12T19:00:00.000Z',supersedes:null});expect(csv.rows[0].normalized?.sourceEventId).toMatch(/^composite:v1:/);expect(csv.rows[0].normalized?.identityDerivation?.eventKey.components.map(c=>c.value)).toEqual(['0010482','004','orderedQuantity']);
 });
 it('advertises strict opt-in batch and identity schemas and mounted transport paths',async()=>{
  const api=JSON.parse(await readFile(new URL('../partner-openapi.json',import.meta.url),'utf8')),schemas=api.components.schemas;
  for(const name of ['TypedSourceBatchV1','TypedSourceBatchV2','SourceIdentityPolicyV1','TypedImportCommit','OperationalSourceReference'])expect(schemas[name].additionalProperties).toBe(false);
  expect(schemas.TypedSourceBatchV1.properties).not.toHaveProperty('identityPolicy');expect(schemas.TypedSourceBatchV2.required).toContain('identityPolicy');expect(schemas.TypedSourceBatchV2.properties).not.toHaveProperty('rows');expect(schemas.TypedSourceBatchV2.properties).not.toHaveProperty('crossCasePolicy');
  for(const path of ['/v1/partner/source-profiles','/v1/partner/source-subscriptions','/v1/partner/typed-imports/preview','/v1/partner/typed-imports/{importId}/commit','/v1/partner/typed-imports/{importId}/record','/v1/partner/cases','/v1/partner/cases/{caseId}'])expect(api.paths[path]).toBeDefined();
  expect(api.paths['/v1/partner/typed-imports/preview'].post.responses['201']).toBeDefined();expect(api.paths['/v1/partner/typed-imports/{importId}/commit'].post.responses['202']).toBeDefined();expect(schemas.OperationalCasePagination.properties.section.enum).toContain('proofs');expect(schemas.OperationalCaseDetail.properties.proofs.items.$ref).toBe('#/components/schemas/OperationalCaseProofMember');expect(schemas.OperationalCaseDetail.properties.pages.properties).toHaveProperty('proofs');expect(schemas.OperationalCaseDetail.properties.totals.properties).toHaveProperty('proofs');expect(schemas.OperationalCaseProofPagination.properties.section.const).toBe('proofs');expect(schemas.OperationalCaseSummary.properties.proofCount).toEqual({type:'integer',minimum:0});expect(schemas.OperationalCaseDetail.properties.schema.const).toBe('packproof.operational-reconstruction/v1');expect(api['x-packproof-existing-data-profile']).toMatchObject({candidate:true,productionQualified:false});const decision=api.paths['/me/records/agent-enrollments/{enrollmentId}/decision'].post.requestBody.content['application/json'].schema;expect(decision.properties.createLocalSource).toEqual({type:'boolean'});expect(decision.properties.integrationAccountId.anyOf).toContainEqual({type:'null'});const action=api.paths['/me/records/agent-installations/{installationId}/actions'].post.requestBody.content['application/json'].schema;expect(action.properties.action.enum).toContain('approve_source_setup');expect(action.properties.configSha256.anyOf).toContainEqual({type:'null'});
 });
 it('publishes bounded historical manifests, current decision reviews and separate collection provenance',async()=>{
  const api=JSON.parse(await readFile(new URL('../partner-openapi.json',import.meta.url),'utf8')),schemas=api.components.schemas;
  expect(schemas.SourceBackfillProposal.properties.originals).toMatchObject({minItems:1,maxItems:100});
  expect(schemas.SourceBackfillOriginal.properties.mediaType).toEqual({const:'text/csv'});
  const filename=new RegExp(schemas.SourceBackfillOriginal.properties.name.pattern);expect(filename.test('older-export.csv')).toBe(true);expect(filename.test('../older-export.csv')).toBe(false);expect(filename.test('nested\\older-export.csv')).toBe(false);
  expect(schemas.SourceBackfillAction.required).toContain('expectedDecisionId');expect(schemas.SourceBackfillAction.properties.expectedDecisionId.anyOf).toContainEqual({type:'null'});
  expect(schemas.SourceBackfillAction.allOf[0].then).toMatchObject({required:['wholeFileConsent','expiresAt'],properties:{wholeFileConsent:{const:true}}});
  expect(schemas.SourceBackfillJob.required).toEqual(expect.arrayContaining(['organizationId','environment','manifestSha256','latestDecisionId','decisionsComplete']));expect(schemas.SourceBackfillJob.properties.decisions.maxItems).toBe(100);
  for(const name of ['TypedSourceBatchV1','TypedSourceBatchV2'])expect(schemas[name].properties.collectionContext).toEqual({$ref:'#/components/schemas/SourceBackfillCollectionContext'});
  expect(schemas.OperationalSourceObservation.properties).not.toHaveProperty('collectionContext');
  for(const prefix of ['/me/records','/v1/partner']){expect(api.paths[`${prefix}/source-subscriptions/{subscriptionId}/backfills`].get.responses['200'].content['application/json'].schema.properties.jobs.maxItems).toBe(10);expect(api.paths[`${prefix}/source-backfills/{jobId}`].get).toBeDefined();}
  expect(api.paths['/v1/partner/source-subscriptions/{subscriptionId}/backfills/proposals'].post.responses['202']).toBeDefined();expect(api.paths['/me/records/source-backfills/{jobId}/actions'].post).toBeDefined();expect(api.paths['/v1/partner/source-backfills/{jobId}/items/{itemId}/bind'].post).toBeDefined();expect(api['x-packproof-existing-data-profile'].defaultOffFlags).toContain('PACKPROOF_SOURCE_BACKFILL_JOBS_ENABLED');
 });
});
