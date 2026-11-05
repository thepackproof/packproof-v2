import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { base64url, flattenedVerify, importSPKI } from 'jose';
import { describe, expect, it } from 'vitest';
import { createOperationalSnapshotSigner, evaluateSnapshotRequirements, operationalEnvelope, OPERATIONAL_SNAPSHOT_TYPE, validateOperationalManifest, type OperationalManifest } from '../src/records/operational-snapshot-profile.js';
import { jcsBytes, sha256 } from '../src/integrity/envelope-profile.js';
import type { KmsSigningTransport } from '../src/integrity/kms-signing-runtime.js';

const fixture=JSON.parse(readFileSync(new URL('../../verifier/operational-snapshot-fixture.json',import.meta.url),'utf8'));
const files:Record<string,Buffer>=Object.fromEntries(Object.entries(fixture.files).map(([name,value])=>[name,Buffer.from(value as string,'base64')]));
const manifest=()=>JSON.parse(files['operational/manifest.json'].toString()) as OperationalManifest;
const keyArn='arn:aws:kms:us-east-1:123456789012:key/11111111-1111-1111-1111-111111111111';

describe('closed operational snapshot signing profile',()=>{
  it('accepts the public independent fixture without rewriting historical core or prior bytes',async()=>{
    const current=manifest();validateOperationalManifest(current);
    const prior=JSON.parse(files['operational/prior-manifest.json'].toString());validateOperationalManifest(prior);
    expect(sha256(files['operational/manifest.json'])).toBe(fixture.expectedManifestSha256);
    expect(sha256(files['operational/prior-manifest.json'])).toBe(current.priorSnapshot!.manifestSha256);
    expect(sha256(files['core/manifest.json'])).toBe(current.core.manifestSha256);
    expect(sha256(jcsBytes(JSON.parse(files['core/manifest.json'].toString())))).not.toBe(current.core.manifestSha256);
    const jws=JSON.parse(files['operational/envelope.jws.json'].toString());
    const verified=await flattenedVerify(jws,await importSPKI(fixture.trust.keys[0].publicKeyPem,'ES256'),{algorithms:['ES256']});
    expect(verified.protectedHeader.typ).toBe(OPERATIONAL_SNAPSHOT_TYPE);
    const envelope=JSON.parse(Buffer.from(verified.payload).toString());
    expect(envelope).toEqual(operationalEnvelope(current,fixture.trust.issuer,envelope.issuedAt));
    expect(current.entities).toHaveLength(prior.entities.length+1);
  });

  it.each([
    ['unknown fields',(m:OperationalManifest)=>{(m as any).unchecked=true;}],
    ['late entity',(m:OperationalManifest)=>{m.entities[0].created_at='2026-11-03T12:00:00.001Z';}],
    ['future record',(m:OperationalManifest)=>{m.record.updatedAt='2026-11-03T12:00:00.001Z';}],
    ['cross Proof row',(m:OperationalManifest)=>{m.links[0].proof_id='other_proof';}],
    ['latest object',(m:OperationalManifest)=>{m.artifacts[0].storage.versionId='null';}],
    ['undeclared evidence',(m:OperationalManifest)=>{m.links[0].evidence_id='absent';}],
    ['conflicting omission',(m:OperationalManifest)=>{m.omissions.push({artifactId:m.artifacts[0].artifactId,reason:'WITHHELD',detail:'Explicit omission'});}],
    ['wrong evaluation',(m:OperationalManifest)=>{m.requirements[0].matching_artifact_ids=[];}],
    ['entity cycle',(m:OperationalManifest)=>{m.entities[0].parent_id=m.entities[1].id;m.entities[1].parent_id=m.entities[0].id;}],
    ['acceptance before receipt',(m:OperationalManifest)=>{m.artifacts[0].source.acceptedAt='2026-11-03T09:00:00.000Z';}],
  ] as const)('rejects %s',(label,mutate)=>{const value=manifest();mutate(value);expect(()=>validateOperationalManifest(value),label).toThrow();});

  it('uses server acceptance time and explicit source subject links for requirement evaluation',()=>{
    const value=manifest(),requirement=value.requirements[0],source=value.artifacts[0];
    requirement.due_at='2026-11-03T10:30:00.000Z';source.source.acceptedAt='2026-11-03T11:00:00.000Z';
    evaluateSnapshotRequirements(value);expect(requirement.evaluation_status).toBe('missing');expect(requirement.matching_artifact_ids).toEqual([]);
    source.kind='SOURCE_ARTIFACT';source.source.actorId='principal_fixture';source.source.receiptSha256='a'.repeat(64);
    source.source.acceptedAt=source.source.receivedAt;requirement.subject_id=value.proofId;value.links=[];
    evaluateSnapshotRequirements(value);expect(requirement.matching_artifact_ids).toEqual([]);
    value.links.push({id:'source_link',proof_id:value.proofId,evidence_id:source.artifactId,subject_id:value.proofId,reason:'Exact source subject',actor_user_id:'user_fixture',created_at:source.source.receivedAt});
    evaluateSnapshotRequirements(value);expect(requirement.matching_artifact_ids).toEqual([source.artifactId]);validateOperationalManifest(value);
    source.source.receiptSha256=null;expect(()=>validateOperationalManifest(value)).toThrow('SOURCE_ATTRIBUTION_REQUIRED');
  });

  it('binds organization, core, prior and accepted membership to the signed manifest digest',()=>{
    const original=JSON.parse(files['operational/envelope.jws.json'].toString());
    const envelope=JSON.parse(Buffer.from(original.payload,'base64url').toString());
    for(const change of [(m:OperationalManifest)=>{m.organizationId='other_organization';},(m:OperationalManifest)=>{m.core.manifestSha256='a'.repeat(64);},(m:OperationalManifest)=>{m.priorSnapshot!.manifestSha256='b'.repeat(64);},(m:OperationalManifest)=>{m.artifacts[0].sha256='c'.repeat(64);}]){
      const value=manifest();change(value);expect(sha256(jcsBytes(value))).not.toBe(envelope.manifestSha256);
    }
  });

  it('rejects payload tampering mathematically with the independently pinned public key',async()=>{
    const jws=JSON.parse(files['operational/envelope.jws.json'].toString());
    const payload=JSON.parse(Buffer.from(jws.payload,'base64url').toString());payload.organizationId='other_organization';jws.payload=base64url.encode(jcsBytes(payload));
    await expect(flattenedVerify(jws,await importSPKI(fixture.trust.keys[0].publicKeyPem,'ES256'),{algorithms:['ES256']})).rejects.toThrow();
  });

  it('uses the explicit managed-key profile, KMS digest input and independently verified DER conversion',async()=>{
    const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKeyPem=pair.publicKey.export({format:'pem',type:'spki'}).toString();
    const envelope=operationalEnvelope(manifest(),'https://synthetic-fixture.invalid','2026-11-03T12:00:00.000Z'),payload=jcsBytes(envelope);
    const protectedHeader=base64url.encode(jcsBytes({alg:'ES256',kid:'operational_test_key',typ:OPERATIONAL_SNAPSHOT_TYPE}));
    const signingInput=Buffer.from(`${protectedHeader}.${base64url.encode(payload)}`);
    const transport:KmsSigningTransport={getPublicKey:async()=>({$metadata:{},KeyId:keyArn,KeySpec:'ECC_NIST_P256',KeyUsage:'SIGN_VERIFY',SigningAlgorithms:['ECDSA_SHA_256'],PublicKey:pair.publicKey.export({format:'der',type:'spki'})}),sign:async request=>{
      expect(request).toMatchObject({KeyId:keyArn,MessageType:'DIGEST',SigningAlgorithm:'ECDSA_SHA_256'});
      expect(Buffer.from(request.Message!)).toEqual(createHash('sha256').update(signingInput).digest());
      return {$metadata:{},KeyId:keyArn,SigningAlgorithm:'ECDSA_SHA_256',Signature:sign('sha256',signingInput,pair.privateKey)};
    }};
    const signer=await createOperationalSnapshotSigner({keyArn,keyId:'operational_test_key',pinnedPublicKeyPem:publicKeyPem,transport});
    const jws=await signer(payload);expect(base64url.decode(jws.signature)).toHaveLength(64);
    const verified=await flattenedVerify(jws,await importSPKI(publicKeyPem,'ES256'),{algorithms:['ES256']});expect(Buffer.from(verified.payload)).toEqual(payload);
    await expect(signer(Buffer.from(JSON.stringify(envelope,null,2)))).rejects.toThrow('NONCANONICAL_ENVELOPE');
    await expect(createOperationalSnapshotSigner({keyArn:'alias/test',keyId:'operational_test_key',pinnedPublicKeyPem:publicKeyPem,transport})).rejects.toThrow('EXACT_KMS_KEY_REQUIRED');
  });
});
