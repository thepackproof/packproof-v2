import { readFileSync } from 'node:fs';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { verify, UInt8, Bool, Field } from 'o1js';
import { PNG } from 'pngjs';
import canonicalize from 'canonicalize';
import { getProfile } from './circuit.mjs';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export function decodeRgb(bytes,size=4){
  const {WIDTH,HEIGHT}=getProfile(size);
  const png=PNG.sync.read(bytes,{skipRescale:false});
  if(png.width!==WIDTH||png.height!==HEIGHT||png.depth!==8) throw Error('unsupported dimensions/format');
  const pixels=[];
  for(let i=0;i<png.data.length;i+=4){ if(png.data[i+3]!==255) throw Error('alpha channel not supported'); pixels.push(...png.data.subarray(i,i+3)); }
  return pixels;
}
export async function verifyBundle(bundle, imageBytes, trust){
  const {CIRCUIT_ID,WIDTH,HEIGHT,PIXELS,RedactionPublic,outputDigestFor}=getProfile(bundle.width);
  if(bundle.schemaVersion!=='packproof.zk-redaction.v1'||bundle.circuitId!==CIRCUIT_ID) throw Error('unknown circuit');
  if(trust.circuitId!==CIRCUIT_ID||sha(trust.verificationKey.data)!==trust.verificationKeyId||bundle.verificationKeyId!==trust.verificationKeyId) throw Error('unknown verification key');
  if(bundle.width!==WIDTH||bundle.height!==HEIGHT||bundle.formatVersion!==1||bundle.transformVersion!==1) throw Error('unsupported format/dimensions');
  if(!Array.isArray(bundle.mask)||bundle.mask.length!==PIXELS||bundle.mask.some(x=>typeof x!=='boolean')) throw Error('nonbinary mask');
  const a=bundle.sourceBinding;
  if(!a||a.record.circuitId!==CIRCUIT_ID||a.record.commitment!==bundle.commitment||a.record.sourceSha256!==trust.expectedSourceSha256||a.record.width!==WIDTH||a.record.height!==HEIGHT||a.record.formatVersion!==1||a.record.assertionKind!=='TRUSTED_PROCESSOR_RGB8_COMMITMENT') throw Error('source binding mismatch/missing');
  const pub=createPublicKey(trust.sourcePublicKeyPem);
  if(a.keyId!==sha(pub.export({type:'spki',format:'der'}))||!verifySignature(null,Buffer.from(canonicalize(a.record)),pub,Buffer.from(a.signature,'base64'))) throw Error('untrusted source binding');
  const pixels=decodeRgb(imageBytes,WIDTH), outputDigest=outputDigestFor(pixels.map(UInt8.from)).toString();
  if(bundle.outputSha256!==sha(imageBytes)||outputDigest!==bundle.outputDigest) throw Error('disclosed output mismatch');
  const publicInput=new RedactionPublic({commitment:Field(bundle.commitment),width:Field(WIDTH),height:Field(HEIGHT),formatVersion:Field(1),transformVersion:Field(1),mask:bundle.mask.map(Bool),outputDigest:Field(outputDigest)});
  const expected=RedactionPublic.toFields(publicInput).map(String);
  if(JSON.stringify(expected)!==JSON.stringify(bundle.proof.publicInput)) throw Error('proof public input mismatch');
  if(!await verify(bundle.proof,trust.verificationKey)) throw Error('invalid zero knowledge proof');
  return {valid:true,verificationLevel:'ZERO_KNOWLEDGE_TRANSFORM_PROOF',circuitId:CIRCUIT_ID,sourceBinding:'trusted processor assertion; decoding/extraction not proven',securityReview:'PENDING',publicReliance:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try { const [b,p,t]=process.argv.slice(2); console.log(JSON.stringify(await verifyBundle(JSON.parse(readFileSync(b)),readFileSync(p),JSON.parse(readFileSync(t))),null,2)); }
  catch(e){console.error(e.message);process.exitCode=1;}
}
