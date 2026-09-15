import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import { IDENTIFIER_FORMATS, type DecoderProfile, type IdentifierDecode } from './identifier-decoder';

// Vite emits the pinned reader into this same site's assets. No CDN or decoded URL is fetched.
prepareZXingModule({overrides:{locateFile:()=>wasmUrl}});
type NativeResult = {rawValue:string;format:string;boundingBox?:{x:number;y:number;width:number;height:number}};
type DetectorConstructor = { new(input:{formats:string[]}): {detect:(image:ImageBitmap)=>Promise<NativeResult[]>}; getSupportedFormats?:()=>Promise<string[]> };
const scope = globalThis as unknown as {BarcodeDetector?:DetectorConstructor;onmessage:((event:MessageEvent<{id:number;bitmap:ImageBitmap}>)=>void)|null;postMessage:(value:unknown)=>void};
let native: InstanceType<DetectorConstructor> | null = null;
let initialized = false;
let profile: DecoderProfile = {supportedFormats:[...IDENTIFIER_FORMATS],multiCodeAnalysis:true,rawBytesAvailable:true,GS1SignalAvailable:true,timestampOrigin:'MONOTONIC_APPROXIMATE',decoderVersion:'zxing-wasm/3.1.3'};
let busy = false;
scope.onmessage = async ({data}) => {
  const {id,bitmap} = data;
  if (busy) { bitmap.close(); scope.postMessage({id,error:'ANALYSIS_BUSY'}); return; }
  busy = true;
  try {
    if (!initialized) {
      initialized = true;
      const Native = scope.BarcodeDetector;
      const supported:string[]|undefined = await Native?.getSupportedFormats?.().catch(()=>[] as string[]);
      if (Native && supported && IDENTIFIER_FORMATS.every(format=>supported.includes(format))) {
        try {
          native = new Native({formats:[...IDENTIFIER_FORMATS]});
          profile = {...profile,rawBytesAvailable:false,GS1SignalAvailable:false,decoderVersion:'browser-barcode-detector/1'};
        } catch { native=null; }
      }
    }
    let codes:IdentifierDecode[];
    if (native) {
      try {
        codes = (await native.detect(bitmap)).slice(0,10).map(code=>({rawText:code.rawValue,rawBytes:null,decoderEncoding:null,symbology:code.format,symbologyIdentifier:null,bounds:code.boundingBox?{x:code.boundingBox.x,y:code.boundingBox.y,width:code.boundingBox.width,height:code.boundingBox.height}:null}));
      } catch { native=null; throw new Error('NATIVE_DECODE_UNAVAILABLE'); }
    } else {
      profile = {...profile,rawBytesAvailable:true,GS1SignalAvailable:true,decoderVersion:'zxing-wasm/3.1.3'};
      const canvas = new OffscreenCanvas(bitmap.width,bitmap.height);
      const context = canvas.getContext('2d',{willReadFrequently:true});
      if (!context) throw new Error('ANALYSIS_UNAVAILABLE');
      context.drawImage(bitmap,0,0);
      const rows = await readBarcodes(context.getImageData(0,0,bitmap.width,bitmap.height),{formats:['EAN13','EAN8','UPCA','UPCE','Code128','Code39','QRCode','DataMatrix','ITF','Code93','Codabar','PDF417','Aztec'],maxNumberOfSymbols:10,tryHarder:false,textMode:'Plain'});
      codes = rows.filter(row=>row.isValid).map(row=>{
        const points=Object.values(row.position), xs=points.map(point=>point.x),ys=points.map(point=>point.y);
        return {rawText:row.text,rawBytes:row.bytes.length<=4096?btoa(String.fromCharCode(...row.bytes)):null,decoderEncoding:row.hasECI?'ECI':'DECODER_TEXT',symbology:row.format,symbologyIdentifier:row.symbologyIdentifier||null,bounds:{x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)}};
      });
    }
    scope.postMessage({id,result:{codes,profile,frameWidth:bitmap.width,frameHeight:bitmap.height}});
  } catch { scope.postMessage({id,error:'ANALYSIS_UNAVAILABLE'}); }
  finally { bitmap.close(); busy=false; }
};
