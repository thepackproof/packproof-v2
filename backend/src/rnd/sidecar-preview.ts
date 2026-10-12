import { deflateSync } from 'node:zlib';
import { bad } from './security.js';

function chunk(type:string,data:Buffer) {
 const payload=Buffer.concat([Buffer.from(type,'ascii'),data]);
 let crc=0xffffffff;
 for(const byte of payload){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
 const length=Buffer.alloc(4),checksum=Buffer.alloc(4);
 length.writeUInt32BE(data.length);checksum.writeUInt32BE((crc^0xffffffff)>>>0);
 return Buffer.concat([length,payload,checksum]);
}

/** Bounded lossless display conversion only. Original PGM bytes and hashes are unchanged. */
export function nativeLumaPreview(bytes:Buffer,frame:Record<string,unknown>):Buffer {
 const width=Number(frame.width),height=Number(frame.height);
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<2||height<2||width*height>2097152)
  bad('RND_SIDECAR_PIXELS','Invalid native frame dimensions');
 const header=Buffer.from(`P5\n${width} ${height}\n255\n`);
 if(bytes.length!==header.length+width*height||!bytes.subarray(0,header.length).equals(header))
  bad('RND_SIDECAR_PIXELS','Native frame bytes do not match their committed dimensions');
 const scanlines=Buffer.alloc((width+1)*height);
 for(let y=0;y<height;y++)bytes.copy(scanlines,y*(width+1)+1,header.length+y*width,header.length+(y+1)*width);
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(scanlines)),chunk('IEND',Buffer.alloc(0))]);
}
