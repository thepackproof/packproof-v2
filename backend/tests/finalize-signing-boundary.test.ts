import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {createPgliteDatabase} from '../src/db/pglite.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {createTransaction,updateTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {commitAttestation} from '../src/domain/attestations.js';
import {finalizeProof} from '../src/domain/finalize.js';
import type {ManifestSigner} from '../src/domain/manifest-signing.js';
import {verifyManifestIntegrity} from '../src/domain/manifest-signing.js';
import {generateKeyPairSync,sign} from 'node:crypto';
import {newId} from '../src/ids.js';
import {sha256Hex} from '../src/hash.js';

describe('finalization signing boundary',()=>{
 let opened:Awaited<ReturnType<typeof createPgliteDatabase>>,user:string;
 const clock={now:()=>new Date()},pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const signer:ManifestSigner={signManifest:async input=>({algorithm:'ECDSA_SHA_256',keyId:'test',signatureBase64:sign('sha256',Buffer.from(input.canonicalJson),pair.privateKey).toString('base64'),signedAt:clock.now().toISOString()})};
 beforeAll(async()=>{opened=await createPgliteDatabase();await migrate(opened.db);user=await insertUser(opened.db,clock);},60000);
 afterAll(async()=>opened?.close());
 async function fixture(){
  const t=await createTransaction(opened.db,clock,user,{itemTitle:'Synthetic signing fixture'});
  const p=await createOrGetProof(opened.db,clock,user,t.transactionId,{participationPolicy:'COUNTERPARTY_OPTIONAL'});
  // A legacy committed evidence fixture isolates signing from camera/media I/O.
  const id=newId('ev'),now=clock.now().toISOString();
  await opened.db.query("INSERT INTO evidence(id,proof_id,submitted_by,object_key,content_type,byte_size,sha256,created_at,committed_at,validation_status,evidence_type,capture_origin) VALUES($1,$2,$3,$4,'video/mp4',1,$5,$6,$6,'COMMITTED','FULFILLMENT_CAPTURE','LEGACY_UNKNOWN')",[id,p.proofId,user,`fixture/${id}`,sha256Hex('x'),now]);
  await commitAttestation(opened.db,clock,user,p.proofId,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:id});
  return {proofId:p.proofId,transactionId:t.transactionId};
 }
 it('releases the database transaction before signing and rejects a changed candidate',async()=>{
  const f=await fixture();
  const concurrent:ManifestSigner={signManifest:async input=>{await updateTransaction(opened.db,clock,user,f.transactionId,{itemTitle:'Changed during signing'});return signer.signManifest(input);}};
  await expect(finalizeProof(opened.db,clock,user,f.proofId,concurrent)).rejects.toMatchObject({code:'FINALIZATION_CONTEXT_CHANGED'});
  expect((await opened.db.query('SELECT id FROM final_manifests WHERE proof_id=$1',[f.proofId])).rows).toHaveLength(0);
 });
 it('keeps signing outages retryable and returns one immutable signed manifest on replay',async()=>{
  const f=await fixture();
  await expect(finalizeProof(opened.db,clock,user,f.proofId,{signManifest:async()=>{throw new Error('SIGNER_OUTAGE');}})).rejects.toThrow('SIGNER_OUTAGE');
  expect((await opened.db.query('SELECT id FROM final_manifests WHERE proof_id=$1',[f.proofId])).rows).toHaveLength(0);
  const final=await finalizeProof(opened.db,clock,user,f.proofId,signer);
  const again=await finalizeProof(opened.db,clock,user,f.proofId,{signManifest:async()=>{throw new Error('must not sign again');}});
  expect(again.manifest).toEqual(final.manifest);
  expect(verifyManifestIntegrity({canonicalJson:final.manifest.canonicalJson,expectedSha256:final.manifest.sha256,signature:final.manifest.signature,publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}).toString()}).signatureValid).toBe(true);
  expect((await opened.db.query('SELECT operation_id FROM recovery_events WHERE operation_id=$1',[`finalize:${f.proofId}`])).rows).toHaveLength(1);
 });
});
