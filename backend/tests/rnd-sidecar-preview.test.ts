import {it,expect} from 'vitest';
import {inflateSync} from 'node:zlib';
import {nativeLumaPreview} from '../src/rnd/sidecar-preview.js';

it('produces a grayscale PNG with exact original pixels, dimensions and no resizing',()=>{
 const original=Buffer.concat([Buffer.from('P5\n3 2\n255\n'),Buffer.from([0,10,255,4,50,128])]),copy=Buffer.from(original);
 const png=nativeLumaPreview(original,{width:3,height:2});
 expect([...png.subarray(0,8)]).toEqual([137,80,78,71,13,10,26,10]);
 const chunks:Record<string,Buffer>={};
 for(let offset=8;offset<png.length;){const n=png.readUInt32BE(offset),kind=png.toString('ascii',offset+4,offset+8);chunks[kind]=png.subarray(offset+8,offset+8+n);offset+=12+n;}
 expect(chunks.IHDR.readUInt32BE(0)).toBe(3);expect(chunks.IHDR.readUInt32BE(4)).toBe(2);
 expect([...chunks.IHDR.subarray(8)]).toEqual([8,0,0,0,0]);
 expect([...inflateSync(chunks.IDAT)]).toEqual([0,0,10,255,0,4,50,128]);
 expect(original).toEqual(copy);
});
it('rejects malformed, truncated, oversized or rebound native frame bytes before conversion',()=>{
 const frame=Buffer.concat([Buffer.from('P5\n2 2\n255\n'),Buffer.alloc(4)]);
 for(const [bytes,dimensions] of [[frame,{width:3,height:2}],[frame.subarray(0,-1),{width:2,height:2}],[frame,{width:2097152,height:2}],[frame,{width:NaN,height:2}]] as const)
  expect(()=>nativeLumaPreview(bytes,dimensions)).toThrow();
});
