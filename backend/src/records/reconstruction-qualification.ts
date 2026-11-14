import {readFileSync,statSync} from 'node:fs';
import {sha256Hex} from '../hash.js';
import {DomainError} from '../domain/errors.js';

/** Public reviewed deployment inputs are bounded and pinned outside the file.
 * Merely setting a capability flag never invents a signing/deletion authority. */
export function readPinnedReconstructionQualification<T>(env:NodeJS.ProcessEnv,prefix:string):T {
 const path=env[`${prefix}_FILE`]?.trim(),expected=env[`${prefix}_SHA256`]?.trim();
 try{
  if(!path||!expected||!/^[a-f0-9]{64}$/.test(expected))throw Error('missing binding');
  const info=statSync(path);if(!info.isFile()||info.size<1||info.size>65536)throw Error('unsafe binding');
  const bytes=readFileSync(path);if(bytes.length!==info.size||sha256Hex(bytes)!==expected)throw Error('binding digest changed');
  return JSON.parse(bytes.toString('utf8')) as T;
 }catch{throw new DomainError('RECONSTRUCTION_QUALIFICATION_UNAVAILABLE','A separately pinned, bounded and reviewed reconstruction runtime qualification is required',503);}
}
