/** Optional analysis of the existing recorder stream. Never owns or changes a track. */
export const IDENTIFIER_FORMATS = ['upc_a','upc_e','ean_8','ean_13','code_128','code_39','qr_code','data_matrix','itf','code_93','codabar','pdf417','aztec'] as const;
export type DecoderProfile = {
  supportedFormats: string[]; multiCodeAnalysis: boolean; rawBytesAvailable: boolean;
  GS1SignalAvailable: boolean; timestampOrigin: 'MONOTONIC_APPROXIMATE'; decoderVersion: string;
};
export type IdentifierDecode = {
  rawText: string; rawBytes: string | null; decoderEncoding: string | null;
  symbology: string; symbologyIdentifier: string | null;
  bounds: { x:number; y:number; width:number; height:number } | null;
};
export type DecodeFrame = { codes: IdentifierDecode[]; profile: DecoderProfile; frameWidth:number; frameHeight:number };
type WorkerReply = { id:number; result?:DecodeFrame; error?:string };

export class BrowserIdentifierDecoder {
  private worker: Worker;
  private pending: {id:number;resolve:(value:DecodeFrame)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>} | null = null;
  private sequence = 0;
  private stopped = false;
  constructor() {
    if (typeof Worker !== 'function' || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function')
      throw new Error('Automatic item recognition is unavailable in this browser.');
    this.worker = new Worker(new URL('./identifier-worker.ts', import.meta.url), {type:'module'});
    this.worker.onmessage = ({data}:{data:WorkerReply}) => {
      if (!this.pending || data.id !== this.pending.id) return;
      const request = this.pending; this.pending = null; clearTimeout(request.timer);
      if (data.result) request.resolve(data.result);
      else request.reject(new Error('Automatic item recognition paused.'));
    };
    this.worker.onerror = () => this.close();
  }
  async detect(video:HTMLVideoElement):Promise<DecodeFrame | null> {
    if (this.stopped || this.pending || !video.videoWidth) return null;
    // Resize only the analysis bitmap. The evidence encoder keeps its original framing.
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth,video.videoHeight));
    const bitmap = await createImageBitmap(video,{resizeWidth:Math.max(1,Math.round(video.videoWidth*scale)),resizeHeight:Math.max(1,Math.round(video.videoHeight*scale))});
    if (this.stopped || this.pending) { bitmap.close(); return null; }
    const id = ++this.sequence;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('Automatic item recognition paused.')); }, 5000);
      this.pending = {id,resolve,reject,timer};
      try { this.worker.postMessage({id,bitmap},[bitmap]); }
      catch { bitmap.close(); this.close(); }
    });
  }
  close() {
    this.stopped = true; this.worker.terminate();
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('Automatic item recognition paused.')); this.pending=null; }
  }
}
