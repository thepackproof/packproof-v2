export const SIDECAR_CHUNK_BYTES = 262144;
export const SIDECAR_MAX_BYTES = 2097216;
export type SidecarFile = {fileName:string;sha256:string;byteLength?:number};
export function nativeSidecarFiles(inventory: {acquisitionSha256?:unknown;journalSha256?:unknown}, acquisition: unknown): SidecarFile[] {
  const files: SidecarFile[]=[];
  if (typeof inventory.acquisitionSha256 === 'string' && /^[a-f0-9]{64}$/.test(inventory.acquisitionSha256)) {
    files.push({fileName:'research-acquisition.json',sha256:inventory.acquisitionSha256});
    const record=acquisition as {schemaVersion?:unknown;frames?:unknown};
    if (record?.schemaVersion!=='packproof.native-acquisition.v1'||!Array.isArray(record.frames)||record.frames.length>6) throw new Error('Invalid native acquisition inventory');
    const names=new Set<string>();
    for (const raw of record.frames) {
      const frame=raw as SidecarFile;
      if(!frame||!/^research-frame-[0-5]\.pgm$/.test(frame.fileName)||names.has(frame.fileName)||!/^[a-f0-9]{64}$/.test(frame.sha256)||!Number.isSafeInteger(frame.byteLength)||frame.byteLength!<1||frame.byteLength!>SIDECAR_MAX_BYTES) throw new Error('Invalid native frame commitment');
      names.add(frame.fileName);files.push({...frame});
    }
  }
  if(typeof inventory.journalSha256==='string'&&/^[a-f0-9]{64}$/.test(inventory.journalSha256))files.push({fileName:'native-journal.jsonl',sha256:inventory.journalSha256});
  return files;
}
