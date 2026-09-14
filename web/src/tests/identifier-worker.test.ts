import {afterEach,expect,it,vi} from 'vitest';
const reader=vi.hoisted(()=>({prepareZXingModule:vi.fn(),readBarcodes:vi.fn(async()=>[])}));
vi.mock('zxing-wasm/reader',()=>reader);
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();vi.clearAllMocks();});
it('selects the bundled worker fallback with native BarcodeDetector disabled',async()=>{
  const postMessage=vi.fn(),close=vi.fn();
  vi.stubGlobal('BarcodeDetector',undefined);vi.stubGlobal('postMessage',postMessage);
  vi.stubGlobal('OffscreenCanvas',class{getContext(){return {drawImage:vi.fn(),getImageData:()=>({width:64,height:64,data:new Uint8ClampedArray(64*64*4)})};}});
  await import('../capture/identifier-worker');
  const callback=(globalThis as unknown as {onmessage:(event:unknown)=>Promise<void>}).onmessage;
  await callback({data:{id:7,bitmap:{width:64,height:64,close}}});
  expect(reader.readBarcodes).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
  expect(postMessage).toHaveBeenCalledWith({id:7,result:{codes:[],frameWidth:64,frameHeight:64,profile:expect.objectContaining({decoderVersion:'zxing-wasm/3.1.3',rawBytesAvailable:true,GS1SignalAvailable:true})}});
  expect(reader.prepareZXingModule.mock.calls[0][0].overrides.locateFile()).not.toMatch(/^https?:/);
});
