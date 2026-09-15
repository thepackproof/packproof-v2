import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach,expect,it,vi } from 'vitest';
import { prepareZXingModule as prepareReader,readBarcodes } from 'zxing-wasm/reader';
import { prepareZXingModule as prepareWriter,writeBarcode } from 'zxing-wasm/writer';
import { classifyIdentifier,normalizeGtin } from '../../../backend/src/identifiers/core';

const require=createRequire(import.meta.url);
afterEach(()=>vi.unstubAllGlobals());
const noNetwork=()=>{throw new Error('The pinned WASM fixtures must run without network access.');};
prepareReader({overrides:{wasmBinary:readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm')),locateFile:()=>'/local-reader.wasm'}});
prepareWriter({overrides:{wasmBinary:readFileSync(require.resolve('zxing-wasm/writer/zxing_writer.wasm')),locateFile:()=>'/local-writer.wasm'}});

it('decodes product, SKU, label and structured QR fixtures using the locally bundled fallback',async()=>{
  vi.stubGlobal('Blob',NodeBlob);
  vi.stubGlobal('fetch',noNetwork);
  // Generated only inside the test harness. No operational order or product data is synthesized.
  const fixtures=[
    {format:'UPCA' as const,text:'036000291452',kind:'PRODUCT'},
    {format:'EAN13' as const,text:'0036000291452',kind:'PRODUCT'},
    {format:'Code128' as const,text:'Blue-001',kind:'OPAQUE'},
    {format:'Code128' as const,text:'1Z999AA10123456784',kind:'OPAQUE'},
    {format:'QRCode' as const,text:'https://id.gs1.org/01/00036000291452/21/SN-A1',kind:'STRUCTURED'},
    {format:'DataMatrix' as const,text:'Part-007',kind:'OPAQUE'},
  ];
  for(const fixture of fixtures){
    const encoded=await writeBarcode(fixture.text,{format:fixture.format,scale:4});
    expect(encoded.error).toBe('');expect(encoded.image).not.toBeNull();
    const decoded=await readBarcodes(encoded.image!,{tryHarder:false,textMode:'Plain',maxNumberOfSymbols:10});
    expect(decoded).toHaveLength(1);
    const result=classifyIdentifier({rawText:decoded[0].text,symbology:decoded[0].format,symbologyIdentifier:decoded[0].symbologyIdentifier});
    expect(result.kind).toBe(fixture.kind);
    if(fixture.kind==='PRODUCT')expect(result.identifiers[0].normalizedValue).toBe(normalizeGtin('036000291452','UPCA'));
    else expect(decoded[0].text).toBe(fixture.text);
  }
});
