export interface ShippingScan {
  rawValue: string;
  format: string;
  detectedAtMs: number;
  idempotencyKey: string;
  confirmed?: boolean;
}
export interface ShippingScanResult {
  status: 'BOUND' | 'NEEDS_CONFIRMATION' | 'UNRECOGNIZED' | 'QUEUED' | 'CONFLICT' | 'UNAVAILABLE';
  trackingNumber?: string;
  carrierHint?: string | null;
  observationId?: string;
  proofId?: string;
  transactionId?: string;
}
export interface QueuedShippingScan { scan: ShippingScan; result: ShippingScanResult; }
export interface ShippingScanJournal {
  proofId: string; sessionId: string; userId: string;
  entries: QueuedShippingScan[];
}

/** No camera dependencies: persist intent before requesting any server mutation. */
export function createShippingScanQueue(input: {
  journal: ShippingScanJournal;
  persist: (journal: ShippingScanJournal) => Promise<void>;
  bind: (scan: ShippingScan) => Promise<ShippingScanResult>;
}) {
  let writes = Promise.resolve();
  const save = () => {
    const snapshot = JSON.parse(JSON.stringify(input.journal)) as ShippingScanJournal;
    const write = writes.then(()=>input.persist(snapshot));
    writes = write.catch(()=>undefined);
    return write;
  };
  const pending = new Map<string, Promise<ShippingScanResult>>();
  async function submit(entry: QueuedShippingScan): Promise<ShippingScanResult> {
    await save();
    try { entry.result = await input.bind(entry.scan); }
    catch (error) {
      const code = (error as {code?:string})?.code;
      // An older API has no label route and returns an unstructured 404. Keep
      // the local scan, but do not make optional autofill block the video upload.
      // Structured authorization/session errors and network failures still queue.
      const routeUnavailable = code==='HTTP_ERROR' && (error as {status?:number})?.status===404;
      entry.result = {status: routeUnavailable ? 'UNAVAILABLE' : code === 'SHIPPING_LABEL_CONFLICT' || code === 'SHIPPING_SCAN_CONFLICT' ? 'CONFLICT' : 'QUEUED'};
    }
    await save();
    return entry.result;
  }
  function run(entry: QueuedShippingScan) {
    const key = entry.scan.idempotencyKey;
    if (pending.has(key)) return pending.get(key)!;
    const promise = submit(entry).finally(()=>pending.delete(key));
    pending.set(key,promise);
    return promise;
  }
  return {
    async detect(scan: ShippingScan): Promise<ShippingScanResult> {
      // Drop product symbologies and rich payloads before they reach storage/API.
      if (/EAN|UPC/i.test(scan.format) || !/^[a-z0-9 \t\r\n-]{10,64}$/i.test(scan.rawValue)) return {status:'UNRECOGNIZED'};
      const identity = scan.rawValue.replace(/[ \t\r\n-]/g,'').toUpperCase();
      let entry = input.journal.entries.find(e=>e.scan.rawValue.replace(/[ \t\r\n-]/g,'').toUpperCase()===identity);
      if (entry) return pending.get(entry.scan.idempotencyKey) ?? entry.result;
      if (input.journal.entries.length>=8) return {status:'UNRECOGNIZED'};
      entry = {scan, result:{status:'QUEUED'}};
      input.journal.entries.push(entry);
      return run(entry);
    },
    async confirm(rawValue: string) {
      const entry = input.journal.entries.find(e=>e.scan.rawValue===rawValue);
      if (!entry || entry.result.status!=='NEEDS_CONFIRMATION') return {status:'UNRECOGNIZED'} as ShippingScanResult;
      // Unaccepted candidates made no server mutation; confirmation gets a fresh key.
      entry.scan = {...entry.scan,confirmed:true,idempotencyKey:`${entry.scan.idempotencyKey}:confirmed`};
      entry.result = {status:'QUEUED'};
      return run(entry);
    },
    async retry() {
      for (const entry of input.journal.entries) if (entry.result.status==='QUEUED' || entry.result.status==='UNAVAILABLE') await run(entry);
      return input.journal.entries;
    },
    flush: () => writes,
  };
}
