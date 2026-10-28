// Independent, bounded reader for PackProof's documented stored ZIP export.
// This is a byte-integrity acceptance probe, not a replacement for verifier/verify.py
// or independent signing-key trust. Never extracts files to disk.
import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const ensure=(ok,message)=>{if(!ok)throw new Error(message);};
export function verifyPackage(bytes,{expectedManifestSha256,expectedProofId,expectedSourceSha256}) {
 ensure(Buffer.isBuffer(bytes)&&bytes.length>=22&&bytes.length<=230*1024*1024,'Invalid bounded package size');
 ensure(/^[a-f0-9]{64}$/.test(expectedManifestSha256)&&/^[a-f0-9]{64}$/.test(expectedSourceSha256),'Independent SHA-256 pins are required');
 const end=bytes.length-22;
 ensure(bytes.readUInt32LE(end)===0x06054b50&&bytes.readUInt16LE(end+4)===0&&bytes.readUInt16LE(end+6)===0&&bytes.readUInt16LE(end+20)===0,'Incomplete or unsupported ZIP end');
 const count=bytes.readUInt16LE(end+10),directorySize=bytes.readUInt32LE(end+12),directoryOffset=bytes.readUInt32LE(end+16);
 ensure(count>0&&count<=4096&&count===bytes.readUInt16LE(end+8)&&directoryOffset+directorySize===end,'Invalid ZIP directory');
 const entries=new Map(),ranges=new Map();let at=directoryOffset,sourceEnd=0;
 for(let i=0;i<count;i++){
  ensure(at+46<=end&&bytes.readUInt32LE(at)===0x02014b50,'Invalid central entry');
  const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),size=bytes.readUInt32LE(at+24),compressed=bytes.readUInt32LE(at+20),nameLength=bytes.readUInt16LE(at+28),extra=bytes.readUInt16LE(at+30),comment=bytes.readUInt16LE(at+32),start=bytes.readUInt32LE(at+42);
  ensure(flags===0x0808&&method===0&&size===compressed&&nameLength>0&&nameLength<=1024&&at+46+nameLength+extra+comment<=end,'Unsupported stored ZIP entry');
  const name=bytes.subarray(at+46,at+46+nameLength).toString('utf8');
  ensure(/^[A-Za-z0-9_./-]+$/.test(name)&&!name.split('/').some(p=>!p||p==='.'||p==='..')&&!entries.has(name),'Invalid duplicate package path');
  ensure(start===sourceEnd&&start+30<=directoryOffset&&bytes.readUInt32LE(start)===0x04034b50&&bytes.readUInt16LE(start+6)===flags&&bytes.readUInt16LE(start+8)===method,'Invalid local ZIP header');
  const localNameLength=bytes.readUInt16LE(start+26),localExtra=bytes.readUInt16LE(start+28),dataStart=start+30+localNameLength+localExtra;
  ensure(localNameLength===nameLength&&bytes.subarray(start+30,start+30+localNameLength).toString('utf8')===name&&dataStart+size+16<=directoryOffset,'Invalid ZIP bounds');
  const descriptor=dataStart+size;
  ensure(bytes.readUInt32LE(descriptor)===0x08074b50&&bytes.readUInt32LE(descriptor+8)===size&&bytes.readUInt32LE(descriptor+12)===size,'Incomplete ZIP source');
  entries.set(name,bytes.subarray(dataStart,descriptor));ranges.set(name,{start:dataStart,end:descriptor});
  sourceEnd=descriptor+16;at+=46+nameLength+extra+comment;
 }
 ensure(at===end&&sourceEnd===directoryOffset,'ZIP entries do not match complete directory');
 const read=name=>{ensure(entries.has(name),'Missing '+name);return entries.get(name);};
 const json=name=>JSON.parse(read(name).toString('utf8'));
 const manifestBytes=read('manifest.json'),manifest=JSON.parse(manifestBytes.toString('utf8')),pkg=json('package.json'),archive=json('archive.json'),inventory=json('integrity/evidence.json'),hashes=json('integrity/hashes.json');
 ensure(sha(manifestBytes)===expectedManifestSha256,'Manifest digest differs from independent pin');
 ensure(pkg.proofId===expectedProofId&&pkg.manifestSha256===expectedManifestSha256&&pkg.canonicalJson===manifestBytes.toString('utf8'),'Package root differs from pinned manifest');
 ensure(archive.snapshot?.proofId===expectedProofId&&archive.snapshot?.manifestSha256===expectedManifestSha256&&Array.isArray(archive.omissions)&&archive.omissions.length===0,'Package has omitted originals or different snapshot');
 ensure(hashes&&typeof hashes==='object'&&!Array.isArray(hashes),'Missing package hash inventory');
 for(const [name,digest]of Object.entries(hashes))ensure(typeof digest==='string'&&sha(read(name))===digest,'File digest mismatch: '+name);
 for(const name of entries.keys())if(name!=='integrity/hashes.json')ensure(Object.hasOwn(hashes,name),'Uninventoried file: '+name);
 ensure(Array.isArray(manifest.evidence)&&manifest.evidence.length>0&&Array.isArray(inventory),'Missing frozen evidence');
 let matchedSource=false;let sourcePath;
 for(const evidence of manifest.evidence){
  const matches=inventory.filter(item=>item.evidenceId===evidence.evidenceId);
  ensure(matches.length===1&&matches[0].status==='INCLUDED'&&typeof matches[0].path==='string','Missing frozen source');
  const row=matches[0],source=read(row.path);
  ensure(row.sha256===evidence.sha256&&row.byteSize===evidence.byteSize&&source.length===evidence.byteSize&&sha(source)===evidence.sha256,'Original does not match frozen source');
  if(evidence.sha256===expectedSourceSha256){matchedSource=true;sourcePath=row.path;}
 }
 ensure(matchedSource,'Independent source pin is absent from package');
 return {proofId:expectedProofId,manifestSha256:expectedManifestSha256,sourceSha256:expectedSourceSha256,packageSha256:sha(bytes),entryCount:entries.size,tamperRange:ranges.get(sourcePath)};
}
