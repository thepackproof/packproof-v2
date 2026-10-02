import {createHash,sign,verify,createPublicKey} from 'node:crypto';
import {canonicalize,parseStrictJson} from './contracts.mjs';
export * from './contracts.mjs';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const digest = value => 'sha256:'+sha256(canonicalize(value));
/** ASCII domain length u32BE + UTF8 domain, then u32BE length + exact bytes per field. */
export function domainDigest(domain,...fields) {
  if(!/^[A-Z0-9_.-]{1,80}$/.test(domain))throw new Error('INVALID_HASH_DOMAIN');
  const hash=createHash('sha256');
  for(const field of [Buffer.from(domain,'ascii'),...fields.map(f=>Buffer.from(f))]) {
    const length=Buffer.alloc(4);length.writeUInt32BE(field.length);hash.update(length).update(field);
  }
  return 'sha256:'+hash.digest('hex');
}
export function signPayload(payload,{keyId,privateKey}) {
  const canonicalJson=canonicalize(payload);
  return {schemaVersion:'packproof.signature.v1',algorithm:'Ed25519',keyId,canonicalJson,payloadDigest:'sha256:'+sha256(canonicalJson),signature:sign(null,Buffer.from(canonicalJson),privateKey).toString('base64')};
}
/** Policy supplied by verifier caller, never inferred from keys inside an untrusted bundle. */
export function verifyPayload(envelope,policy,now=new Date().toISOString()) {
  const failure=reason=>({valid:false,reason,payload:null});
  try {
    if(envelope?.schemaVersion!=='packproof.signature.v1'||envelope.algorithm!=='Ed25519')return failure('UNSUPPORTED_SIGNATURE');
    const entry=policy?.keys?.find(key=>key.keyId===envelope.keyId);
    if(!entry||entry.revoked||entry.algorithm!=='Ed25519')return failure('UNTRUSTED_OR_REVOKED_KEY');
    const instant=Date.parse(now);if(!Number.isFinite(instant)||!entry.validFrom||!entry.validUntil||instant<Date.parse(entry.validFrom)||instant>Date.parse(entry.validUntil)||!Number.isFinite(Date.parse(entry.validFrom))||!Number.isFinite(Date.parse(entry.validUntil)))return failure('KEY_OUTSIDE_TRUST_INTERVAL');
    const payload=parseStrictJson(envelope.canonicalJson);
    if(canonicalize(payload)!==envelope.canonicalJson||envelope.payloadDigest!=='sha256:'+sha256(envelope.canonicalJson))return failure('PAYLOAD_CHANGED');
    if(!/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature))return failure('INVALID_SIGNATURE_ENCODING');
    const key=createPublicKey(entry.publicKeyPem);if(key.asymmetricKeyType!=='ed25519')return failure('KEY_ALGORITHM_MISMATCH');
    if(!verify(null,Buffer.from(envelope.canonicalJson),key,Buffer.from(envelope.signature,'base64')))return failure('INVALID_SIGNATURE');
    return {valid:true,reason:null,payload};
  } catch {return failure('MALFORMED_SIGNATURE');}
}
