export * from './contracts.mjs';
export function sha256(bytes:string|Uint8Array):string;
export function digest(value:unknown):string;
export function domainDigest(domain:string,...fields:(string|Uint8Array)[]):string;
export interface SignatureEnvelope {schemaVersion:'packproof.signature.v1';algorithm:'Ed25519';keyId:string;canonicalJson:string;payloadDigest:string;signature:string;}
export interface TrustPolicy {policyId:string;keys:{keyId:string;algorithm:'Ed25519';publicKeyPem:string;validFrom:string;validUntil:string;revoked:boolean}[];}
export function signPayload(payload:unknown,key:{keyId:string;privateKey:unknown}):SignatureEnvelope;
export function verifyPayload(envelope:SignatureEnvelope,policy:TrustPolicy,now?:string):{valid:boolean;reason:string|null;payload:unknown};
