import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyPackage} from './package-check.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
function storedZip(files){
 const local=[],central=[];let offset=0;
 for(const [name,data]of Object.entries(files)){
  const filename=Buffer.from(name),bytes=Buffer.from(data),header=Buffer.alloc(30),descriptor=Buffer.alloc(16),entry=Buffer.alloc(46);
  header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x0808,6);header.writeUInt16LE(filename.length,26);
  descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(bytes.length,8);descriptor.writeUInt32LE(bytes.length,12);
  entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x0808,8);entry.writeUInt32LE(bytes.length,20);entry.writeUInt32LE(bytes.length,24);entry.writeUInt16LE(filename.length,28);entry.writeUInt32LE(offset,42);
  local.push(header,filename,bytes,descriptor);central.push(entry,filename);offset+=30+filename.length+bytes.length+16;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,directory,end]);
}
function fixture(){
 const source=Buffer.from('Synthetic original, never physical packing evidence.'),sourceSha=sha(source),proofId='proof_synthetic';
 const manifest=Buffer.from(JSON.stringify({proofId,evidence:[{evidenceId:'ev_synthetic',sha256:sourceSha,byteSize:source.length}]})),manifestSha=sha(manifest);
 const files={'manifest.json':manifest,'package.json':JSON.stringify({proofId,manifestSha256:manifestSha,canonicalJson:manifest.toString('utf8')}),'archive.json':JSON.stringify({snapshot:{proofId,manifestSha256:manifestSha},omissions:[]}),'integrity/evidence.json':JSON.stringify([{evidenceId:'ev_synthetic',path:'evidence/original.bin',sha256:sourceSha,byteSize:source.length,status:'INCLUDED'}]),'evidence/original.bin':source};
 files['integrity/hashes.json']=JSON.stringify(Object.fromEntries(Object.entries(files).map(([n,b])=>[n,sha(Buffer.from(b))])));
 return {files,pins:{expectedManifestSha256:manifestSha,expectedProofId:proofId,expectedSourceSha256:sourceSha}};
}
test('independent package pins verify originals and reject a changed byte',()=>{
 const {files,pins}=fixture(),bytes=storedZip(files),result=verifyPackage(bytes,pins);
 assert.equal(result.sourceSha256,pins.expectedSourceSha256);assert.equal(result.entryCount,6);
 const changed=Buffer.from(bytes);changed[result.tamperRange.start]^=1;assert.throws(()=>verifyPackage(changed,pins),/digest mismatch|frozen source/);
});
test('self-consistent replacement cannot replace the independent manifest pin',()=>{
 const {files,pins}=fixture();files['manifest.json']=Buffer.from(JSON.stringify({proofId:'proof_other',evidence:[]}));
 files['integrity/hashes.json']=JSON.stringify(Object.fromEntries(Object.entries(files).filter(([n])=>n!=='integrity/hashes.json').map(([n,b])=>[n,sha(Buffer.from(b))])));
 assert.throws(()=>verifyPackage(storedZip(files),pins),/independent pin/);
});
test('incomplete directory, traversal paths, omissions and wrong source pins fail closed',()=>{
 const {files,pins}=fixture(),bytes=storedZip(files);assert.throws(()=>verifyPackage(bytes.subarray(0,-1),pins));
 assert.throws(()=>verifyPackage(bytes,{...pins,expectedSourceSha256:'0'.repeat(64)}),/source pin/);
 const omitted={...files,'archive.json':JSON.stringify({snapshot:{proofId:pins.expectedProofId,manifestSha256:pins.expectedManifestSha256},omissions:[{evidenceId:'ev_synthetic'}]})};
 assert.throws(()=>verifyPackage(storedZip(omitted),pins),/omitted originals/);
 const traversed={...files,'../escape.txt':'bad'};assert.throws(()=>verifyPackage(storedZip(traversed),pins),/package path/);
});
