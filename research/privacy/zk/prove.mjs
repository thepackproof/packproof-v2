/** Two-stage local R&D CLI: bind hidden source first, then prove a selected mask. */
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { createPrivateKey,createPublicKey,sign,verify as verifySignature } from 'node:crypto';
import { Field,UInt8,Bool,Cache,setNumberOfWorkers } from 'o1js';
import { PNG } from 'pngjs';
import canonicalize from 'canonicalize';
import { getProfile } from './circuit.mjs';
import { sha,decodeRgb,verifyBundle } from './verify.mjs';
setNumberOfWorkers(2);
const [command,...args]=process.argv.slice(2);
const json=p=>JSON.parse(readFileSync(p));
function save(p,x,mode=0o644){writeFileSync(p,JSON.stringify(x,null,2),{flag:'wx',mode});}
try {
 if(command==='commit-source'){
  const [source,keyFile,privateWitness,bindingFile]=args;
  if(!bindingFile)throw Error('commit-source <4x4-or-8x8.png> <issuer-ed25519.pem> <PRIVATE-witness.json> <binding.json>');
  const sourceBytes=readFileSync(source);
  const {CIRCUIT_ID,WIDTH,HEIGHT,commitmentFor}=getProfile(PNG.sync.read(sourceBytes).width);
  const pixels=decodeRgb(sourceBytes,WIDTH),blind=Field.random(),key=createPrivateKey(readFileSync(keyFile)),pub=createPublicKey(key);
  if(key.asymmetricKeyType!=='ed25519')throw Error('source signer must be Ed25519');
  const commitment=commitmentFor(pixels.map(UInt8.from),blind).toString();
  const record={schemaVersion:'packproof.pixel-source-binding.v1',assertionKind:'TRUSTED_PROCESSOR_RGB8_COMMITMENT',sourceSha256:sha(sourceBytes),canonicalPixelsSha256:sha(Buffer.from(pixels)),commitment,circuitId:CIRCUIT_ID,width:WIDTH,height:HEIGHT,formatVersion:1,extraction:'PNG decoded to RGB8; decoding is trusted, not proven',createdAt:new Date().toISOString()};
  // This file is private opening material, never part of an export.
  save(privateWitness,{schemaVersion:'packproof.private-rgb8-witness.v1',sourceSha256:record.sourceSha256,blind:blind.toString(),pixels},0o600);
  save(bindingFile,{record,keyId:sha(pub.export({type:'spki',format:'der'})),signature:sign(null,Buffer.from(canonicalize(record)),key).toString('base64')});
  console.log(JSON.stringify({commitment,sourceSha256:record.sourceSha256,sourceBinding:bindingFile,requiresImmutableSourceInventoryRegistration:true}));
 } else if(command==='prove'){
  const [privateWitness,bindingFile,maskFile,sourcePublicKey,expectedSourceSha256,outDir]=args;
  if(!outDir)throw Error('prove <PRIVATE-witness.json> <binding.json> <mask.json> <TRUSTED-source-public.pem> <inventory-source-sha256> <new-output-dir>');
  const witness=json(privateWitness),binding=json(bindingFile),mask=json(maskFile),pub=createPublicKey(readFileSync(sourcePublicKey));
  const {CIRCUIT_ID,WIDTH,HEIGHT,PIXELS,Redaction,RedactionPublic,ImagePixels,commitmentFor,outputDigestFor}=getProfile(binding.record.width);
  if(!Array.isArray(mask)||mask.length!==PIXELS||mask.some(x=>typeof x!=='boolean'))throw Error(`mask requires exactly ${PIXELS} booleans`);
  if(witness.schemaVersion!=='packproof.private-rgb8-witness.v1'||witness.sourceSha256!==expectedSourceSha256||binding.record.sourceSha256!==expectedSourceSha256)throw Error('source inventory mismatch');
  if(binding.keyId!==sha(pub.export({type:'spki',format:'der'}))||!verifySignature(null,Buffer.from(canonicalize(binding.record)),pub,Buffer.from(binding.signature,'base64')))throw Error('untrusted source binding');
  if(!Array.isArray(witness.pixels)||witness.pixels.length!==PIXELS*3||witness.pixels.some(x=>!Number.isInteger(x)||x<0||x>255))throw Error('invalid RGB8 private witness');
  const channels=witness.pixels.map(UInt8.from),blind=Field(witness.blind),commitment=commitmentFor(channels,blind).toString();
  if(binding.record.commitment!==commitment||binding.record.canonicalPixelsSha256!==sha(Buffer.from(witness.pixels)))throw Error('private source opening mismatch');
  const output=witness.pixels.map((x,i)=>mask[Math.floor(i/3)]?0:x),png=new PNG({width:WIDTH,height:HEIGHT});
  for(let i=0;i<PIXELS;i++){png.data.set(output.slice(i*3,i*3+3),i*4);png.data[i*4+3]=255;}
  const bytes=PNG.sync.write(png),outputDigest=outputDigestFor(output.map(UInt8.from));
  mkdirSync(outDir,{recursive:false});
  const {verificationKey}=await Redaction.compile({cache:Cache.FileSystem(`${outDir}/prover-cache`)});
  const input=new RedactionPublic({commitment:Field(commitment),width:Field(WIDTH),height:Field(HEIGHT),formatVersion:Field(1),transformVersion:Field(1),mask:mask.map(Bool),outputDigest});
  const {proof}=await Redaction.redact(input,new ImagePixels({channels}),blind);
  const trust={circuitId:CIRCUIT_ID,verificationKey:{data:verificationKey.data,hash:verificationKey.hash.toString()},verificationKeyId:sha(verificationKey.data),expectedSourceSha256,sourcePublicKeyPem:pub.export({type:'spki',format:'pem'})};
  const bundle={schemaVersion:'packproof.zk-redaction.v1',circuitId:CIRCUIT_ID,verificationKeyId:trust.verificationKeyId,width:WIDTH,height:HEIGHT,formatVersion:1,transformVersion:1,mask,commitment,outputDigest:outputDigest.toString(),outputSha256:sha(bytes),sourceBinding:binding,proof:proof.toJSON()};
  await verifyBundle(bundle,bytes,trust);save(`${outDir}/proof.json`,bundle);save(`${outDir}/proposed-public-trust.json`,trust);writeFileSync(`${outDir}/output.png`,bytes,{flag:'wx'});
  console.log(JSON.stringify({proved:true,circuitId:CIRCUIT_ID,verificationKeyId:trust.verificationKeyId,warning:'Trust material must be pinned out of band by reviewer; never auto-trust a key shipped by prover.',securityReview:'PENDING'}));
 } else throw Error('Expected commit-source or prove');
} catch(e){console.error(e.message);process.exitCode=1;}
