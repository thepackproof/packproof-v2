import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import cbor from 'cbor';
import * as asn1 from 'asn1js';
import request from 'supertest';
import { createServerApp } from '../src/server-app.js';
import { BearerUserAdapter } from '../src/auth/adapter.js';
import { createHarness, createUser, type TestHarness } from './helpers.js';
import { createTransaction } from '../src/domain/transactions.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { createCaptureSession } from '../src/domain/capture-sessions.js';
import { recordConsent, issueIntent, startIntent } from '../src/rnd/capture.js';
import { enabledResearchConfig } from '../src/rnd/config.js';
import { issuePlatformChallenge, verifyPlatformChallenge, loadPlatformAssuranceConfig } from '../src/rnd/platform-assurance-service.js';
import type { RndDeps } from '../src/rnd/types.js';
import type { ManifestSigningRuntime } from '../src/integrity/signing-runtime.js';

const sha = (v: Uint8Array | string) => createHash('sha256').update(v).digest();

describe('database-backed optional platform assurance lifecycle', () => {
  let h: TestHarness, deps: RndDeps, seller: string, outsider: string;
  let now = Date.now();
  const signingKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signing: ManifestSigningRuntime = { publicStatus: { mode:'SIGNED',algorithm:'ECDSA_SHA_256',keyId:'platform-fixture-signer',required:true,trustListSha256:null }, signer: { async signManifest(input) { return { algorithm:'ECDSA_SHA_256',keyId:'platform-fixture-signer',signedAt:new Date(now).toISOString(),signatureBase64:sign('sha256',Buffer.from(input.canonicalJson),signingKeys.privateKey).toString('base64') }; } } };
  beforeAll(async () => { h=await createHarness({now:()=>new Date(now)},{manifestSigning:signing}); seller=await createUser(h);outsider=await createUser(h);deps={...h,rnd:enabledResearchConfig(),manifestSigning:signing}; },30000);
  afterAll(async () => { await h?.close(); });
  async function prepared(mode:'ONLINE'|'OFFLINE'='ONLINE') {
    const transaction=await createTransaction(h.db,h.clock,seller,{itemTitle:'Generated assurance protocol fixture'});
    const p=await createOrGetProof(h.db,h.clock,seller,transaction.transactionId);
    await recordConsent(deps,seller,p.proofId,'consent',{purpose:'EXPERIMENTAL_ANALYSIS',version:'packproof.research-consent.v1',granted:true});
    const issued=await issueIntent(deps,seller,p.proofId,'intent',{legId:'OUTBOUND',acquisitionMode:mode,profileId:'protocol-fixture'});
    const capture=await createCaptureSession(h.db,h.clock,seller,p.proofId,{client:'NATIVE_CAMERA',idempotencyKey:'capture'});
    await startIntent(deps,seller,p.proofId,issued.intent.id,'start',{nonce:issued.intent.nonce,captureSessionId:capture.id});
    return { proofId:p.proofId,intentId:issued.intent.id };
  }
  it('binds signed challenges to subject, purpose and inventory; retries remain stable and unauthorized access fails', async () => {
    const p=await prepared(),body={intentId:p.intentId,purpose:'CLOSE_INVENTORY',inventoryDigest:'a'.repeat(64)};
    const first=await issuePlatformChallenge(deps,seller,p.proofId,'challenge',body);
    expect(await issuePlatformChallenge(deps,seller,p.proofId,'challenge',body)).toEqual(first);
    expect(Buffer.from(first.expectedClientDataHash,'base64')).toEqual(sha(first.canonicalJson));
    expect(Buffer.from(first.requestHash,'base64url')).toEqual(sha(first.canonicalJson));
    await expect(issuePlatformChallenge(deps,seller,p.proofId,'challenge',{...body,inventoryDigest:'b'.repeat(64)})).rejects.toMatchObject({code:'RND_IDEMPOTENCY_CONFLICT'});
    await expect(issuePlatformChallenge(deps,outsider,p.proofId,'other',body)).rejects.toMatchObject({code:'PARTICIPANT_NOT_AUTHORIZED'});
    const offline=await prepared('OFFLINE');
    await expect(issuePlatformChallenge(deps,seller,offline.proofId,'offline',{intentId:offline.intentId,purpose:'REGISTER_KEY'})).rejects.toMatchObject({code:'RND_OFFLINE_NOT_FRESH'});
  });
  it('persists unsupported attempts honestly, consumes them once, and prevents rewriting results', async () => {
    const p=await prepared(),issued=await issuePlatformChallenge(deps,seller,p.proofId,'challenge',{intentId:p.intentId,purpose:'CLOSE_INVENTORY',inventoryDigest:'c'.repeat(64)});
    deps.rnd!.platform=undefined;
    const input={platform:'android',token:'opaque-not-a-hardware-claim'};
    const checked=await verifyPlatformChallenge(deps,seller,p.proofId,issued.challenge.challengeId,'verify',input);
    expect(checked.assurance.state).toBe('UNSUPPORTED');
    expect(await verifyPlatformChallenge(deps,seller,p.proofId,issued.challenge.challengeId,'same-input-retry',input)).toEqual(checked);
    await expect(verifyPlatformChallenge(deps,seller,p.proofId,issued.challenge.challengeId,'changed',{...input,token:'different'})).rejects.toMatchObject({code:'RND_PLATFORM_CHALLENGE_CONSUMED'});
    await expect(h.db.query('UPDATE rnd_platform_results SET state=\'VALIDATED\' WHERE challenge_id=$1',[issued.challenge.challengeId])).rejects.toThrow(/IMMUTABLE/);
    expect(checked.canonicalJson).not.toContain(input.token);
  });
  it('validates an injected Google response with the exact server binding and retains its signed source scope', async () => {
    const p=await prepared(),issued=await issuePlatformChallenge(deps,seller,p.proofId,'challenge',{intentId:p.intentId,purpose:'CLOSE_INVENTORY',inventoryDigest:'d'.repeat(64)});
    const cert=sha('protocol certificate').toString('base64url');
    deps.rnd!.platform={android:{packageName:'com.packproof.mobile.research',certificateSha256Digests:[cert],minimumVersionCode:'55',requiredDeviceVerdicts:['MEETS_DEVICE_INTEGRITY'],requireLicensed:true,maxTokenAgeMs:120000,decodeToken:async()=>({tokenPayloadExternal:{requestDetails:{requestPackageName:'com.packproof.mobile.research',requestHash:issued.requestHash,timestampMillis:String(now)},appIntegrity:{packageName:'com.packproof.mobile.research',certificateSha256Digest:[cert],versionCode:'55',appRecognitionVerdict:'PLAY_RECOGNIZED'},deviceIntegrity:{deviceRecognitionVerdict:['MEETS_DEVICE_INTEGRITY']},accountDetails:{appLicensingVerdict:'LICENSED'}}})}};
    const checked=await verifyPlatformChallenge(deps,seller,p.proofId,issued.challenge.challengeId,'verify',{platform:'android',token:'google-transport-fixture'});
    expect(checked.assurance).toMatchObject({state:'VALIDATED',proofId:p.proofId,intentId:p.intentId,inventoryDigest:'d'.repeat(64),purpose:'CLOSE_INVENTORY'});
    const expired=await issuePlatformChallenge(deps,seller,p.proofId,'expires',{intentId:p.intentId,purpose:'CLOSE_INVENTORY',inventoryDigest:'e'.repeat(64)});
    now+=120001;
    expect((await verifyPlatformChallenge(deps,seller,p.proofId,expired.challenge.challengeId,'verify-expired',{platform:'android',token:'old'})).assurance.state).toBe('INVALID');
  });
  it('registers a real generated Apple-format certificate and advances assertion counter atomically (test root only)', async () => {
    const p=await prepared(),registration=await issuePlatformChallenge(deps,seller,p.proofId,'register',{intentId:p.intentId,purpose:'REGISTER_KEY'});
    const temporary=mkdtempSync(join(tmpdir(),'packproof-platform-service-'));
    try {
      const run=(...args:string[])=>execFileSync('openssl',args,{cwd:temporary,stdio:['ignore','pipe','pipe']});
      run('req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout','root.key','-out','root.pem','-days','2','-sha256','-subj','/CN=TEST ONLY App Attest Root','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign');
      run('req','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout','leaf.key','-out','leaf.csr','-subj','/CN=TEST ONLY App Attest Key');
      const privateKey=readFileSync(join(temporary,'leaf.key'),'utf8'),jwk=createPublicKey(privateKey).export({format:'jwk'}),x=Buffer.from(jwk.x!,'base64url'),y=Buffer.from(jwk.y!,'base64url');
      const keyId=sha(Buffer.concat([Buffer.from([4]),x,y])),appId='TESTTEAM.com.packproof.mobile.research';
      const header=Buffer.alloc(87);sha(appId).copy(header);header[32]=0xc0;Buffer.from('appattestdevelop').copy(header,37);header.writeUInt16BE(32,53);keyId.copy(header,55);
      const authData=Buffer.concat([header,cbor.encode(new Map<unknown,unknown>([[1,2],[3,-7],[-1,1],[-2,x],[-3,y]])),cbor.encode({apple_validation_category_01:3,apple_bundle_version_01:'1'})]);
      const nonce=sha(Buffer.concat([authData,Buffer.from(registration.expectedClientDataHash,'base64')]));
      const ext=Buffer.from(new asn1.Sequence({value:[new asn1.Constructed({idBlock:{tagClass:3,tagNumber:1},value:[new asn1.OctetString({valueHex:nonce})]})]}).toBER(false));
      writeFileSync(join(temporary,'leaf.ext'),`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n1.2.840.113635.100.8.2=DER:${ext.toString('hex').match(/../g)!.join(':')}\n`);
      run('x509','-req','-in','leaf.csr','-CA','root.pem','-CAkey','root.key','-set_serial','2','-out','leaf.pem','-days','1','-sha256','-extfile','leaf.ext');
      deps.rnd!.platform={apple:{appId,environment:'development',trustedRootCertificatesPem:[readFileSync(join(temporary,'root.pem'),'utf8')],trustPolicyId:'TEST_ONLY_ROOT',trustPolicyExpiresAt:now+300000,allowedValidationCategories:[3],allowedBundleVersions:['1']}};
      const attestationObjectBase64=cbor.encode({fmt:'apple-appattest',attStmt:{x5c:[run('x509','-in','leaf.pem','-outform','DER')],receipt:Buffer.from('TEST RECEIPT')},authData}).toString('base64');
      const registered=await verifyPlatformChallenge(deps,seller,p.proofId,registration.challenge.challengeId,'register-verify',{platform:'ios',keyId:keyId.toString('base64'),attestationObjectBase64});
      expect(registered.assurance.reasonCodes).toEqual([]);expect(registered.assurance.state).toBe('VALIDATED');
      const close=await issuePlatformChallenge(deps,seller,p.proofId,'close',{intentId:p.intentId,purpose:'CLOSE_INVENTORY',inventoryDigest:'f'.repeat(64)});
      const assertionHeader=Buffer.alloc(37);sha(appId).copy(assertionHeader);assertionHeader[32]=0x80;assertionHeader.writeUInt32BE(1,33);
      const authenticatorData=Buffer.concat([assertionHeader,cbor.encode({validationCategory:3,bundleVersion:'1'})]);
      const signature=sign('sha256',Buffer.concat([authenticatorData,Buffer.from(close.expectedClientDataHash,'base64')]),privateKey);
      const assertionObjectBase64=cbor.encode({signature,authenticatorData}).toString('base64');
      const verified=await verifyPlatformChallenge(deps,seller,p.proofId,close.challenge.challengeId,'close-verify',{platform:'ios',keyId:keyId.toString('base64'),assertionObjectBase64});
      expect(verified.assurance.state).toBe('VALIDATED');
      const saved=(await h.db.query<{counter:string}>('SELECT counter FROM rnd_platform_key_counters WHERE key_id=$1',[keyId.toString('base64')])).rows[0];expect(Number(saved.counter)).toBe(1);
      await expect(h.db.query('UPDATE rnd_platform_key_counters SET counter=0 WHERE key_id=$1',[keyId.toString('base64')])).rejects.toThrow(/MONOTONIC/);
      const replay=await issuePlatformChallenge(deps,seller,p.proofId,'replay',{intentId:p.intentId,purpose:'CLOSE_INVENTORY',inventoryDigest:'f'.repeat(64)});
      expect((await verifyPlatformChallenge(deps,seller,p.proofId,replay.challenge.challengeId,'replay-verify',{platform:'ios',keyId:keyId.toString('base64'),assertionObjectBase64})).assurance.reasonCodes).toContain('ASSERTION_COUNTER_REPLAY');
    }finally{rmSync(temporary,{recursive:true,force:true});}
  },30000);
  it('does not load configured trust in a production or implicit environment', () => {
    expect(loadPlatformAssuranceConfig({})).toBeUndefined();
    expect(()=>loadPlatformAssuranceConfig({PACKPROOF_RND_PLATFORM_POLICY_FILE:'unused',PACKPROOF_ENV:'production',PACKPROOF_RND_ENABLED:'1'})).toThrow(/isolated/);
  });
  it('mounts authenticated endpoints with no-store responses and honors the kill switch', async () => {
    const p=await prepared(),app=createServerApp({...deps,auth:new BearerUserAdapter(h.db),publicBaseUrl:'http://127.0.0.1',devAuth:true,testFixtures:true});
    const url=`/proofs/${p.proofId}/rnd/platform-challenges`,body={intentId:p.intentId,purpose:'REGISTER_KEY'};
    expect((await request(app).post(url).send(body)).status).toBe(401);
    const issued=await request(app).post(url).set('Authorization',`Bearer ${seller}`).set('Idempotency-Key','http-platform').send(body);
    expect(issued.status).toBe(201);expect(issued.headers['cache-control']).toContain('no-store');
    deps.rnd!.platform=undefined;
    const verified=await request(app).post(`${url}/${issued.body.challenge.challengeId}/verify`).set('Authorization',`Bearer ${seller}`).set('Idempotency-Key','http-verify').send({platform:'android',token:'http-protocol-fixture'});
    expect(verified.status).toBe(200);expect(verified.body.assurance.state).toBe('UNSUPPORTED');
    deps.rnd!.killSwitch=true;
    try {expect((await request(app).post(url).set('Authorization',`Bearer ${seller}`).set('Idempotency-Key','blocked').send(body)).status).toBe(404);}
    finally {deps.rnd!.killSwitch=false;}
  });
});
