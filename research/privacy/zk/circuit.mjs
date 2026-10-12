import { Bool, Field, Poseidon, Provable, Struct, UInt8, ZkProgram } from 'o1js';
// Two deliberately tiny exact RGB8 profiles. No resizing or decoding is proven.
const profiles=new Map();
export function getProfile(size=4){
 if(![4,8].includes(size))throw Error('unsupported fixed RGB8 circuit profile');
 if(profiles.has(size))return profiles.get(size);
 const WIDTH=size,HEIGHT=size,PIXELS=size*size,CHANNELS=PIXELS*3,CIRCUIT_ID=`packproof-rgb8-opaque-${size}x${size}-v1`;
 const INPUT_DOMAIN=Field(0x5050534849454c4431n),OUTPUT_DOMAIN=Field(0x50504f555450555431n);
 class ImagePixels extends Struct({channels:Provable.Array(UInt8,CHANNELS)}){}
 class RedactionPublic extends Struct({commitment:Field,width:Field,height:Field,formatVersion:Field,transformVersion:Field,mask:Provable.Array(Bool,PIXELS),outputDigest:Field}){}
 const commitmentFor=(channels,blind)=>Poseidon.hash([INPUT_DOMAIN,Field(WIDTH),Field(HEIGHT),Field(1),blind,...channels.map(c=>c.value)]);
 const outputDigestFor=channels=>Poseidon.hash([OUTPUT_DOMAIN,Field(WIDTH),Field(HEIGHT),Field(1),...channels.map(c=>c.value)]);
 const Redaction=ZkProgram({name:CIRCUIT_ID,publicInput:RedactionPublic,methods:{redact:{privateInputs:[ImagePixels,Field],async method(input,image,blind){
  input.width.assertEquals(WIDTH);input.height.assertEquals(HEIGHT);input.formatVersion.assertEquals(1);input.transformVersion.assertEquals(1);
  const output=[];
  for(let p=0;p<PIXELS;p++){
   Bool.check(input.mask[p]);
   for(let c=0;c<3;c++){
    const channel=image.channels[p*3+c];UInt8.check(channel);
    output.push(Provable.if(input.mask[p],UInt8,UInt8.from(0),channel));
   }
  }
  commitmentFor(image.channels,blind).assertEquals(input.commitment);
  outputDigestFor(output).assertEquals(input.outputDigest);
 }}}});
 const profile={WIDTH,HEIGHT,PIXELS,CHANNELS,CIRCUIT_ID,ImagePixels,RedactionPublic,commitmentFor,outputDigestFor,Redaction};profiles.set(size,profile);return profile;
}
export const {WIDTH,HEIGHT,PIXELS,CHANNELS,CIRCUIT_ID,ImagePixels,RedactionPublic,commitmentFor,outputDigestFor,Redaction}=getProfile(4);
