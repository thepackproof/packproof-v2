/**
 * Trusted server only. Never place a PackProof service credential in a client bundle.
 * Operation routes and idempotency support are generated from the checked-in contracts.
 */
import { operations } from './operations.mjs';
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
export class PackProofError extends Error {
  constructor(message, fields = {}) { super(message); this.name = 'PackProofError'; Object.assign(this, fields); }
}
export function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  if (/^\d+$/.test(value)) { const n = Number(value) * 1000; return Number.isFinite(n) ? n : null; }
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return null;
  const at = Date.parse(value); return Number.isFinite(at) ? Math.max(0, at - now) : null;
}
async function jsonBody(response, limit) {
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel(); throw new PackProofError('Metadata response exceeds configured bound', {code:'RESPONSE_TOO_LARGE'}); }
  if (!response.body) return null;
  const reader = response.body.getReader(); const parts = []; let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) throw new PackProofError('Metadata response exceeds configured bound', {code:'RESPONSE_TOO_LARGE'});
      parts.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) {bytes.set(part, offset);offset += part.length;}
  if (!size) return null;
  try {return JSON.parse(new TextDecoder().decode(bytes));} catch {throw new PackProofError('PackProof returned invalid JSON', {code:'INVALID_RESPONSE'});}
}
export class PackProofClient {
  constructor({apiOrigin,credential,merchantId,delegationId,fetch:transport = globalThis.fetch,
    timeoutMs = 15000,maxAttempts = 3,maxRetryDelayMs = 15000,maxResponseBytes = 1048576,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),random = Math.random,now = Date.now}) {
    const origin = new URL(apiOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/')
      throw new Error('Configure one HTTPS API origin without credentials, path, query or fragment');
    if (typeof credential !== 'string' || !credential || /[\r\n]/.test(credential)) throw new Error('A server-side credential is required');
    for (const value of [merchantId,delegationId]) if (value != null && (typeof value !== 'string' || !value || /[\r\n]/.test(value))) throw new Error('Invalid merchant context');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
        !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 4 ||
        !Number.isInteger(maxRetryDelayMs) || maxRetryDelayMs < 0 || maxRetryDelayMs > 60000 ||
        !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 8388608) throw new Error('Invalid bounded client settings');
    this.origin=origin.origin;this.headers={Authorization:`Bearer ${credential}`,...(merchantId?{'PackProof-Merchant-Id':merchantId}:{}),...(delegationId?{'PackProof-Delegation-Id':delegationId}:{})};
    Object.assign(this,{transport,timeoutMs,maxAttempts,maxRetryDelayMs,maxResponseBytes,sleep,random,now});
  }
  /**
   * A mutation is retried only if the contract declares Idempotency-Key support
   * and this request supplies one. The serialized body/key are frozen for every attempt.
   * Upload targets are deliberately outside this metadata client.
   */
  async request(operationId, {path = {},query = {},body,key,signal,stream = false} = {}) {
    const op = operations[operationId]; if (!op) throw new Error('Unknown generated operation');
    if (op.method === 'GET' && body !== undefined) throw new Error('GET metadata operations cannot carry a body');
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 200 || /[\r\n]/.test(key))) throw new Error('Invalid Idempotency-Key');
    if (op.idempotent && op.method !== 'GET' && (typeof key !== 'string' || !key.trim() || key.length > 200 || /[\r\n]/.test(key))) throw new Error('Persist a stable Idempotency-Key before sending this command');
    let route = op.path.replace(/\{([^}]+)\}/g, (_all, name) => {
      if (typeof path[name] !== 'string' || !path[name] || path[name] === '.' || path[name] === '..') throw new Error('Missing operation path parameter');
      return encodeURIComponent(path[name]);
    });
    const url = new URL(route, this.origin);
    if (url.origin !== this.origin || !route.startsWith('/')) throw new Error('Operation escaped the configured API origin');
    for (const [name,value] of Object.entries(query)) {
      if (!op.query.includes(name)) throw new Error('Unknown operation query parameter');
      if (value !== undefined && value !== null) url.searchParams.set(name,String(value));
    }
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const retrySafe = op.method === 'GET' || (op.idempotent && Boolean(key));
    const headers = {...this.headers,...(serialized!==undefined?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})};
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      signal?.throwIfAborted();
      let response; let deadline;
      try {
        const timeout = new AbortController();
        deadline = setTimeout(() => timeout.abort(new Error('Request deadline exceeded')), this.timeoutMs);
        response = await this.transport(url,{method:op.method,headers,body:serialized,redirect:'error',signal:signal?AbortSignal.any([signal,timeout.signal]):timeout.signal});
      } catch {
        clearTimeout(deadline);
        signal?.throwIfAborted();
        if (!retrySafe || attempt + 1 === this.maxAttempts) throw new PackProofError('Request outcome is unknown; reconcile before changing the operation key or order identity',{code:'TRANSPORT_FAILURE',unknownOutcome:op.method !== 'GET'});
        await this.pause(Math.min(this.maxRetryDelayMs,250*2**attempt*(0.5+this.random())),signal);continue;
      }
      const requestId = response.headers.get('X-Request-Id') ?? undefined;
      if (response.ok) {
        if (stream || op.binary) { clearTimeout(deadline); return response; }
        try { return await jsonBody(response,this.maxResponseBytes); } finally { clearTimeout(deadline); }
      }
      const after = retryAfterMs(response.headers.get('Retry-After'),this.now());
      const delay = after ?? Math.min(this.maxRetryDelayMs,250*2**attempt*(0.5+this.random()));
      if (retrySafe && RETRYABLE.has(response.status) && attempt + 1 < this.maxAttempts && delay <= this.maxRetryDelayMs) {
        clearTimeout(deadline);
        await response.body?.cancel().catch(() => {});
        await this.pause(delay,signal);continue;
      }
      let payload; try {payload=await jsonBody(response,this.maxResponseBytes);}catch {payload=null;}finally {clearTimeout(deadline);}
      const code = payload?.code ?? payload?.error?.code ?? 'HTTP_ERROR';
      throw new PackProofError(`PackProof request failed (${response.status})`,{status:response.status,code:typeof code==='string'?code:'HTTP_ERROR',requestId,retryAfterMs:after,unknownOutcome:op.method!=='GET' && (response.status===408 || response.status>=500)});
    }
    throw new Error('Unreachable retry state');
  }
  async pause(ms,signal) {
    signal?.throwIfAborted();
    if (!signal) {await this.sleep(ms);return;}
    let rejectAbort;
    const aborted=new Promise((_resolve,reject)=>{rejectAbort=()=>reject(signal.reason??new Error('Aborted'));signal.addEventListener('abort',rejectAbort,{once:true});});
    try {await Promise.race([this.sleep(ms),aborted]);} finally {signal.removeEventListener('abort',rejectAbort);}
    signal.throwIfAborted();
  }
}
