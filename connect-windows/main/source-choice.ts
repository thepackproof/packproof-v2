import {win32} from 'node:path';
/** A chooser default only. The native service still validates every selection. */
export function preparedExportPath(channel:string, programData?:string):string {
  if(!['development','staging','production'].includes(channel))throw Error('Unknown installed environment.');
  const root=programData&&/^[A-Za-z]:[\\/]/.test(programData)?programData:'C:\\ProgramData';
  return win32.join(root,'PackProof','Exports',channel==='production'?'live':channel);
}
export function canOfferPreparedFolder(error:unknown):boolean {
  return error instanceof Error&&/\bSOURCE_(?:ACCESS_DENIED|NOT_FOUND|READ_FAILED)\b/.test(error.message);
}
