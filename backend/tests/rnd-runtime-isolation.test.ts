import { describe,it,expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { rndConfigFromEnv } from '../src/rnd/config.js';
import { assertResearchRuntimeIsolation } from '../src/rnd/runtime-isolation.js';
const safe={PACKPROOF_ENV:'research',PACKPROOF_ENVIRONMENT:'research',PACKPROOF_DEV_AUTH:'true',PACKPROOF_CREDENTIAL_STORE:'memory',PGLITE_DIR:'/tmp/packproof-rnd-runtime'};
describe('research runtime isolation before all external initialization',()=>{
 it('permits local research with all optional features off',()=>expect(()=>assertResearchRuntimeIsolation(loadConfig(safe),rndConfigFromEnv(safe),safe)).not.toThrow());
 it('source marker blocks renamed or unflagged research code against ordinary runtime defaults',()=>expect(()=>assertResearchRuntimeIsolation(loadConfig({}),rndConfigFromEnv({}),{})).toThrow(/research environment/));
 it.each([
  {DATABASE_URL:'postgres://person:secret@rds.example.test:5432/production'},
  {DATABASE_URL:'postgres://person:secret@127.0.0.1:5432/production'},
  {PACKPROOF_OBJECT_STORAGE:'s3',AWS_S3_BUCKET:'live'},
  {AWS_PROFILE:'production'},
  {PACKPROOF_AUTH_MODE:'cognito'},
  {PACKPROOF_MANIFEST_SIGNING_MODE:'kms'},
  {PACKPROOF_PUBLIC_URL:'https://api.thepackproof.com'},
  {PACKPROOF_WEB_ORIGINS:'https://thepackproof.com'},
  {PACKPROOF_RECOVERY_WORKER:'true'},
  {PACKPROOF_STRIPE_SECRET_KEY:'synthetic-live-credential'},
 ])('rejects inherited external settings without exposing credential values: %j',extra=>{const env={...safe,...extra};expect(()=>assertResearchRuntimeIsolation(loadConfig(env),rndConfigFromEnv(env),env)).toThrow(/Research runtime isolation/);});
});
