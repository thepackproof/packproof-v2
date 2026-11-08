import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const TERMINAL = new Set(['succeeded', 'partially_succeeded', 'failed', 'cancelled', 'action_needed', 'ready', 'expired']);
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
  const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(finish, ms);
  const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
  signal?.addEventListener('abort', abort, { once: true });
});

export class PackProofError extends Error {
  constructor(message, { status = 0, requestId = null, body = null, headers = new Headers(), cause } = {}) {
    super(message, { cause });
    this.name = 'PackProofError';
    this.status = status;
    this.requestId = requestId;
    this.body = body;
    this.headers = headers;
    this.code = body && typeof body === 'object' ? body.code ?? body.error?.code ?? body.title ?? null : null;
  }
}

function nonempty(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new TypeError(`${name} must be a nonempty single-line string`);
  return value;
}

function bounded(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

function retryDelay(header, attempt, now) {
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, 30000);
  }
  return Math.min(500 * 2 ** attempt + Math.floor(Math.random() * 250), 30000);
}

/** Server-side only. Credentials never belong in a browser bundle. */
export class PackProofClient {
  constructor({ baseUrl, token, merchantId, delegationId, timeoutMs = 15000, maxAttempts = 3, fetch: fetcher = globalThis.fetch, sleep: sleeper = sleep, allowInsecureLocalhost = false }) {
    this.baseUrl = new URL(baseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(this.baseUrl.hostname);
    if (this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash ||
        (this.baseUrl.protocol !== 'https:' && !(allowInsecureLocalhost && local && this.baseUrl.protocol === 'http:'))) {
      throw new TypeError('baseUrl must be an HTTPS API URL without credentials, query, or fragment');
    }
    this.baseUrl.pathname = this.baseUrl.pathname.replace(/\/$/, '');
    this.token = nonempty(token, 'token');
    this.merchantId = merchantId == null ? undefined : nonempty(merchantId, 'merchantId');
    this.delegationId = delegationId == null ? undefined : nonempty(delegationId, 'delegationId');
    this.timeoutMs = bounded(timeoutMs, 'timeoutMs', 1, 300000);
    this.maxAttempts = bounded(maxAttempts, 'maxAttempts', 1, 5);
    if (typeof fetcher !== 'function' || typeof sleeper !== 'function') throw new TypeError('fetch and sleep must be functions');
    this.fetcher = fetcher;
    this.sleeper = sleeper;
  }

  async request(path, { method = 'GET', body, idempotencyKey, ifMatch, signal, rawBody, contentType, binary = false } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\r\n#]/.test(path)) throw new TypeError('Use an API-relative path beginning with one slash');
    const methodName = method.toUpperCase();
    if(rawBody!==undefined&&(!(rawBody instanceof Uint8Array)||rawBody.byteLength<1||rawBody.byteLength>5242880||body!==undefined||methodName!=='PUT'))throw new TypeError('Upload a nonempty Uint8Array part of at most 5 MiB with PUT');
    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const headers = new Headers({ Accept: 'application/json', Authorization: `Bearer ${this.token}` });
    if (payload !== undefined) headers.set('Content-Type', rawBody===undefined?'application/json':nonempty(contentType,'contentType'));
    if(rawBody!==undefined)headers.set('Content-Length',String(rawBody.byteLength));
    if(binary)headers.set('Accept','application/octet-stream');
    if (this.merchantId) headers.set('PackProof-Merchant-Id', this.merchantId);
    if (this.delegationId) headers.set('PackProof-Delegation-Id', this.delegationId);
    if (idempotencyKey !== undefined) headers.set('Idempotency-Key', nonempty(idempotencyKey, 'idempotencyKey'));
    if (ifMatch !== undefined) headers.set('If-Match', nonempty(ifMatch, 'ifMatch'));
    const safeRetry = methodName === 'GET' || methodName === 'HEAD' || idempotencyKey !== undefined || rawBody!==undefined&&/^\/v1\/partner\/upload-sessions\/[^/]+\/parts\/[1-9][0-9]*$/.test(path);
    const attempts = safeRetry ? this.maxAttempts : 1;
    const url = `${this.baseUrl.href.replace(/\/$/, '')}${path}`;
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal?.throwIfAborted();
      let response;
      try {
        const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
        response = await this.fetcher(url, { method: methodName, headers, body: payload, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal });
      } catch (cause) {
        if (signal?.aborted) throw signal.reason ?? cause;
        if (attempt + 1 < attempts) { await this.sleeper(retryDelay(null, attempt, Date.now()), signal); continue; }
        throw new PackProofError('PackProof request did not receive a response; retry with the same idempotency key', { cause });
      }
      let raw;
      if(binary&&response.ok){
        const reader=response.body?.getReader();if(!reader)throw new PackProofError('The download response has no readable body',{status:response.status});
        const chunks=[];let bytes=0;
        try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>250000000)throw new PackProofError('The download exceeded the supported 250 MB limit');chunks.push(next.value);}}
        finally{await reader.cancel();reader.releaseLock();}
        const data=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
        return {data,rawBody:data,status:response.status,headers:response.headers,requestId:response.headers.get('X-Request-Id'),replayed:false};
      }
      try { raw = await response.text(); }
      catch (cause) {
        if (signal?.aborted) throw signal.reason ?? cause;
        if (attempt + 1 < attempts) { await this.sleeper(retryDelay(null, attempt, Date.now()), signal); continue; }
        throw new PackProofError('PackProof response was interrupted; retain the command identity and retry safely', { status: response.status, requestId: response.headers.get('X-Request-Id'), headers: response.headers, cause });
      }
      let data = raw || null;
      if (raw) { try { data = JSON.parse(raw); } catch { /* Preserve a non-JSON response for diagnosis. */ } }
      const requestId = response.headers.get('X-Request-Id') ?? (data && typeof data === 'object' ? data.requestId ?? data.error?.operationId ?? null : null);
      if (response.ok) return { data, rawBody: raw, status: response.status, headers: response.headers, requestId, replayed: response.headers.get('Idempotency-Replayed') === 'true' };
      if (RETRYABLE.has(response.status) && attempt + 1 < attempts) { await this.sleeper(retryDelay(response.headers.get('Retry-After'), attempt, Date.now()), signal); continue; }
      const message = data && typeof data === 'object' ? data.detail ?? data.message ?? data.error?.message ?? 'PackProof request failed' : 'PackProof request failed';
      throw new PackProofError(message, { status: response.status, requestId, body: data, headers: response.headers });
    }
    throw new Error('Unreachable retry state');
  }

  createProof(input, options) { requireKey(options); return this.request('/v1/partner/proofs', { ...options, method: 'POST', body: input }); }
  getProof(proofId, options) { return this.request(`/v1/partner/proofs/${segment(proofId)}`, options); }
  getRecord(proofId, options) { return this.request(`/v1/partner/proofs/${segment(proofId)}/record`, options); }
  getTimeline(proofId, { cursor, limit, signal } = {}) { return this.request(withQuery(`/v1/partner/proofs/${segment(proofId)}/timeline`, { cursor, limit }), { signal }); }
  getEvidence(proofId, { cursor, limit, signal } = {}) { return this.request(withQuery(`/v1/partner/proofs/${segment(proofId)}/evidence`, { cursor, limit }), { signal }); }
  getRequirements(proofId, options) { return this.request(`/v1/partner/proofs/${segment(proofId)}/requirements`, options); }
  updateRecord(proofId, input, options) { return this.request(`/v1/partner/proofs/${segment(proofId)}`, { ...revisionOptions(options), method: 'PATCH', body: input }); }
  closeRecord(proofId, reason, options) { return this.request(`/v1/partner/proofs/${segment(proofId)}/close`, { ...revisionOptions(options), method: 'POST', body: { reason } }); }
  reopenRecord(proofId, reason, options) { return this.request(`/v1/partner/proofs/${segment(proofId)}/reopen`, { ...revisionOptions(options), method: 'POST', body: { reason } }); }
  appendAmendment(proofId, input, options) { return this.request(`/v1/partner/proofs/${segment(proofId)}/amendments`, { ...revisionOptions(options), method: 'POST', body: input }); }
  appendEntity(proofId, input, options) { return this.request(`/v1/partner/proofs/${segment(proofId)}/entities`, { ...revisionOptions(options), method: 'POST', body: input }); }
  linkEvidence(proofId, input, options) { return this.request(`/v1/partner/proofs/${segment(proofId)}/evidence-links`, { ...revisionOptions(options), method: 'POST', body: input }); }
  listProofs({ after, signal } = {}) { return this.request(withQuery('/v1/partner/proofs', { after }), { signal }); }
  resolveProof(integrationAccountId, externalId, options) { return this.request(withQuery('/v1/partner/proofs/resolve', { integrationAccountId, externalId }), options); }
  requestCapture(proofId, input, options) { requireKey(options); return this.request(`/v1/partner/proofs/${segment(proofId)}/capture-intents`, { ...options, method: 'POST', body: input }); }
  listEvents({ after, limit, signal } = {}) { return this.request(withQuery('/v1/partner/event-stream', { after, limit }), { signal }); }
  createWebhook(input, options) { requireKey(options); return this.request('/v1/partner/webhooks', { ...options, method: 'POST', body: input }); }
  listWebhooks(options) { return this.request('/v1/partner/webhooks', options); }
  revokeWebhook(webhookId, options) { requireKey(options); return this.request(`/v1/partner/webhooks/${segment(webhookId)}`, { ...options, method: 'DELETE' }); }
  matchEntityReference(proofId,reference,options){return this.request(withQuery('/v1/partner/proofs/'+segment(proofId)+'/entity-matches',{reference}),options);}
  listIssueReviewers(proofId,options){return this.request('/v1/partner/proofs/'+segment(proofId)+'/issue-reviewers',options);}
  assignIssue(issueId,input,options){return this.request('/v1/partner/issues/'+segment(issueId)+'/assignment',{...revisionOptions(options),method:'POST',body:input});}
  getLimits(options) { return this.request('/v1/partner/limits', options); }
  listIssues({ status, proofId, cursor, limit, signal } = {}) { return this.request(withQuery('/v1/partner/issues', { status, proofId, cursor, limit }), { signal }); }
  actOnIssue(issueId, input, options) { return this.request(`/v1/partner/issues/${segment(issueId)}/actions`, { ...revisionOptions(options), method: 'POST', body: input }); }
  listConnections({ cursor, limit, signal } = {}) { return this.request(withQuery('/v1/partner/connections', { cursor, limit }), { signal }); }
  listAuditEvents({ operation, resourceId, from, to, cursor, limit, signal } = {}) { return this.request(withQuery('/v1/partner/audit-events', { operation, resourceId, from, to, cursor, limit }), { signal }); }
  listWebhookDeliveries({ state, webhookId, cursor, limit, signal } = {}) { return this.request(withQuery('/v1/partner/webhook-deliveries', { state, webhookId, cursor, limit }), { signal }); }
  replayWebhookDelivery(deliveryId, reason, options) { requireKey(options); return this.request(`/v1/partner/webhook-deliveries/${segment(deliveryId)}/replay`, { ...options, method: 'POST', body: { reason } }); }
  resolveSourceReference(input, options) { return this.request('/v1/partner/source-references/resolve', { ...options, method: 'POST', body: input }); }
  createSourceObservation(input, options) { requireKey(options); return this.request('/v1/partner/source-observations', { ...options, method: 'POST', body: input }); }
  getSourceObservation(id, options) { return this.request(`/v1/partner/operations/${segment(id)}`, options); }
  createIngestion(input, options) { requireKey(options); return this.request('/v1/partner/ingestions', { ...options, method: 'POST', body: input }); }
  getOperation(operationId, options) { return this.request(`/v1/partner/operations/${segment(operationId)}`, options); }
  waitForOperation(operationId, options) { return this.pollOperation(`/v1/partner/operations/${segment(operationId)}`, options); }
  previewImport(input,options){requireKey(options);return this.request('/v1/partner/imports',{...options,method:'POST',body:input});}
  getImport(id,options){return this.request(`/v1/partner/imports/${segment(id)}`,options);}
  commitImport(id,input,options){requireKey(options);return this.request(`/v1/partner/imports/${segment(id)}/commit`,{...options,method:'POST',body:input});}
  createUploadSession(input,options){requireKey(options);return this.request('/v1/partner/upload-sessions',{...options,method:'POST',body:input});}
  getUploadSession(id,options){return this.request(`/v1/partner/upload-sessions/${segment(id)}`,options);}
  uploadPart(id,partNumber,bytes,contentType,options={}){bounded(partNumber,'partNumber',1,48);return this.request(`/v1/partner/upload-sessions/${segment(id)}/parts/${partNumber}`,{...options,method:'PUT',rawBody:bytes,contentType});}
  assembleUpload(id,options){return this.request(`/v1/partner/upload-sessions/${segment(id)}/parts/complete`,{...options,method:'POST',body:{}});}
  completeUpload(id,options){return this.request(`/v1/partner/upload-sessions/${segment(id)}/complete`,{...options,method:'POST',body:{}});}
  getArtifactOperation(id,options){return this.request(`/v1/partner/artifact-operations/${segment(id)}`,options);}
  downloadEvidence(id,options){return this.request(`/v1/partner/evidence/${segment(id)}/download`,{...options,method:'POST',body:{},binary:true});}
  listSnapshots(proofId,options){return this.request(`/v1/partner/proofs/${segment(proofId)}/snapshots`,options);}
  listOperationalSnapshots(proofId,options){return this.request(`/v1/partner/proofs/${segment(proofId)}/operational-snapshots`,options);}
  downloadOperationalSnapshot(proofId,id,options){return this.request(`/v1/partner/proofs/${segment(proofId)}/operational-snapshots/${segment(id)}/package`,{...options,binary:true});}
  createExport(input,options){requireKey(options);return this.request('/v1/partner/exports',{...options,method:'POST',body:input});}
  getExport(id,options){return this.request(`/v1/partner/exports/${segment(id)}`,options);}
  downloadExport(id,options){return this.request(`/v1/partner/exports/${segment(id)}/package`,{...options,binary:true});}
  createShare(input,options){requireKey(options);return this.request('/v1/partner/shares',{...options,method:'POST',body:input});}
  listShares(proofId,options){return this.request(`/v1/partner/proofs/${segment(proofId)}/shares`,options);}
  revokeShare(id,reason,options){return this.request(`/v1/partner/shares/${segment(id)}/revoke`,{...options,method:'POST',body:{reason}});}
  previewDeletion(proofId,options){return this.request(`/v1/partner/proofs/${segment(proofId)}/deletion-impact`,options);}
  requestDeletion(input,options){requireKey(options);return this.request('/v1/partner/deletion-requests',{...options,method:'POST',body:input});}
  getDeletionRequest(id,options){return this.request(`/v1/partner/deletion-requests/${segment(id)}`,options);}
  async uploadArtifact(input,bytes,{resumeSessionId,onProgress,...options}={}){
    requireKey(options);if(!(bytes instanceof Uint8Array)||bytes.byteLength!==input.byteSize||bytes.byteLength<1||bytes.byteLength>250000000)throw new TypeError('Artifact bytes must exactly match the declared supported size');
    const digest=createHash('sha256').update(bytes).digest('hex');if(input.sha256&&input.sha256.toLowerCase()!==digest)throw new TypeError('Artifact bytes do not match the declared SHA-256');
    const initialized=resumeSessionId?await this.getUploadSession(resumeSessionId,options):await this.createUploadSession({...input,sha256:digest},options),s=initialized.data;
    if(!s||s.proofId!==input.proofId||s.contentType!==input.contentType||s.byteSize!==bytes.byteLength||s.filename!==input.filename||s.connectionId!==input.connectionId||(s.expectedSha256&&s.expectedSha256!==digest)||(input.sourceArtifactId&&s.sourceArtifactId!==input.sourceArtifactId))throw new PackProofError('The resume receipt belongs to different source bytes or metadata',{body:s});
    if(s.state==='complete'&&s.operation?.operationId)return this.getArtifactOperation(s.operation.operationId,options);
    if(s.blockedReason||['expired','rejected'].includes(s.state))throw new PackProofError('This source upload cannot resume; retain its receipt and review the source settings',{body:s});
    if(s.state==='received')return this.completeUpload(s.sessionId,options);
    const partSize=bounded(s.partSize,'partSize',1,5242880),parts=new Map((s.receivedParts??[]).map(p=>[p.partNumber,p]));let accepted=0;
    for(let offset=0,n=1;offset<bytes.byteLength;offset+=partSize,n++){
      options.signal?.throwIfAborted();const chunk=bytes.subarray(offset,Math.min(offset+partSize,bytes.byteLength)),old=parts.get(n),hash=createHash('sha256').update(chunk).digest('hex');
      if(old&&(old.byteSize!==chunk.byteLength||old.sha256!==hash))throw new PackProofError('An accepted part belongs to different bytes; the original receipt cannot be overwritten',{body:old});
      if(!old)await this.uploadPart(s.sessionId,n,chunk,input.contentType,options);accepted+=chunk.byteLength;onProgress?.({sessionId:s.sessionId,artifactId:s.artifactId,acceptedBytes:accepted,totalBytes:bytes.byteLength});
    }
    await this.assembleUpload(s.sessionId,options);return this.completeUpload(s.sessionId,options);
  }

  async *proofIds({ after, maxPages = 10000, signal } = {}) {
    bounded(maxPages, 'maxPages', 1, 100000);
    for (let page = 0; page < maxPages; page++) {
      const { data } = await this.listProofs({ after, signal });
      if (!data || !Array.isArray(data.proofIds)) throw new PackProofError('Unexpected Proof page response', { body: data });
      yield* data.proofIds;
      if (!data.hasMore) return;
      if (typeof data.nextCursor !== 'string' || !data.nextCursor || data.nextCursor === after) throw new PackProofError('Proof pagination did not advance', { body: data });
      after = data.nextCursor;
    }
    throw new PackProofError('Proof pagination exceeded maxPages; save the cursor and resume explicitly');
  }

  async *eventPages({ after, limit = 100, maxPages = 10000, signal } = {}) {
    bounded(maxPages, 'maxPages', 1, 100000);
    for (let page = 0; page < maxPages; page++) {
      const result = await this.listEvents({ after, limit, signal });
      yield result;
      if (!result.data.hasMore) return;
      if (typeof result.data.nextCursor !== 'string' || !result.data.nextCursor || result.data.nextCursor === after) throw new PackProofError('Event pagination did not advance', { body: result.data });
      after = result.data.nextCursor;
    }
    throw new PackProofError('Event pagination exceeded maxPages; save the cursor and resume explicitly');
  }

  async *timelinePages(proofId, options = {}) { yield* this.childPages('getTimeline', proofId, options); }
  async *evidencePages(proofId, options = {}) { yield* this.childPages('getEvidence', proofId, options); }
  async *childPages(method, proofId, { cursor, limit = 50, maxPages = 10000, signal } = {}) {
    bounded(maxPages, 'maxPages', 1, 100000);
    bounded(limit, 'limit', 1, 100);
    for (let page = 0; page < maxPages; page++) {
      const result = await this[method](proofId, { cursor, limit, signal });
      yield result;
      if (!result.data.hasMore) return;
      if (typeof result.data.nextCursor !== 'string' || !result.data.nextCursor || result.data.nextCursor === cursor) throw new PackProofError('Record child pagination did not advance', { body: result.data });
      cursor = result.data.nextCursor;
    }
    throw new PackProofError('Record child pagination exceeded maxPages; save the cursor and resume explicitly');
  }

  /** Poll an operation URL returned by the API; never invent a success from a timeout. */
  async pollOperation(path, { intervalMs = 1000, timeoutMs = 60000, signal } = {}) {
    bounded(intervalMs, 'intervalMs', 1, 30000);
    bounded(timeoutMs, 'timeoutMs', 1, 3600000);
    const deadline = Date.now() + timeoutMs;
    const deadlineSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
    while (true) {
      const result = await this.request(path, { signal: combinedSignal });
      if (TERMINAL.has(result.data?.state)) return result;
      if (Date.now() >= deadline) throw new PackProofError('Operation is still processing; retain its receipt and check again', { body: result.data });
      await this.sleeper(Math.min(intervalMs, deadline - Date.now()), combinedSignal);
    }
  }
}

function requireKey(options) { nonempty(options?.idempotencyKey, 'idempotencyKey'); }
function revisionOptions(options) { requireKey(options); bounded(options.revision, 'revision', 1, 999999999); return { ...options, ifMatch: `"${options.revision}"` }; }
function segment(value) { return encodeURIComponent(nonempty(value, 'identifier')); }
function withQuery(path, values) { const q = new URLSearchParams(); for (const [key, value] of Object.entries(values)) if (value != null) q.set(key, String(value)); return `${path}${q.size ? `?${q}` : ''}`; }

/** Verify the exact received bytes before parsing JSON. Event ID deduplication is the receiver's durable responsibility. */
export function verifyWebhook({ secret, signature, rawBody, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300 }) {
  if (typeof secret !== 'string' || !secret || typeof signature !== 'string' || !(typeof rawBody === 'string' || rawBody instanceof Uint8Array) ||
      !Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 0) return false;
  const match = /^t=(\d{1,16}),v1=([a-f0-9]{64})$/.exec(signature);
  if (!match || !Number.isSafeInteger(Number(match[1])) || Math.abs(nowSeconds - Number(match[1])) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${Number(match[1])}.`).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(match[2], 'hex'));
}
