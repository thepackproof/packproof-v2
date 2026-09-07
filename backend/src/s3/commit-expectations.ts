import type { ObjectDigest } from './object-store.js';
import { DomainError } from '../domain/errors.js';
export interface CommitExpectations {sha256?:string;byteSize?:number;contentType?:string;maxBytes?:number;}
export function assertCommitExpectations(actual:ObjectDigest,expected:CommitExpectations={}):void{
  if(actual.byteSize<1||actual.byteSize>(expected.maxBytes??250_000_000))throw new DomainError('INVALID_EVIDENCE_SIZE','Uploaded bytes do not match the reserved recording size',422);
  if(expected.byteSize!==undefined&&actual.byteSize!==expected.byteSize)throw new DomainError('EVIDENCE_SIZE_MISMATCH','Uploaded bytes do not match the registered recording size',422);
  if(expected.contentType&&actual.contentType.split(';')[0].trim().toLowerCase()!==expected.contentType.split(';')[0].trim().toLowerCase())throw new DomainError('EVIDENCE_METADATA_MISMATCH','Uploaded media type does not match the recording reservation',422);
  if(expected.sha256&&actual.sha256!==expected.sha256.toLowerCase())throw new DomainError('EVIDENCE_HASH_MISMATCH','Uploaded bytes do not match the expected complete-file SHA-256',422);
}
