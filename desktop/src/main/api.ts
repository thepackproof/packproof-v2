import type { OnboardingState, Action } from "../../../packages/onboarding/model";
import { randomUUID } from 'node:crypto';
import type { DesktopConfig } from './config.js';
import type { CanonicalProof, ProfileView, ProofCollectionItem, FulfillmentQueueItem, PackingStationResolveView, ConnectedAccountsListView, CommerceConnectionView, CommerceSyncView, EvidenceUploadView, AccessLinkView, PublicProofView, TransactionWriteInput, ManifestView, ShipmentIntegrityView } from '../../../web/src/api/types.js';

export class DesktopApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) { super(message); this.name = 'DesktopApiError'; }
}
export interface CaptureSession {
  id: string; proofId: string; state: string; expiresAt: string; recoverUntil: string;
  maxRecordingBytes: number; maxRecordingSeconds: number; evidenceId?: string | null;
  sha256?: string | null; byteSize?: number | null;
}
export interface DesktopCapabilities {
  schemaVersion: number;
  capture: { protocolVersions: number[]; maxBytes: number; maxDurationSeconds: number; maxActiveUploads: number };
  desktopCapture?: { registrationVersions: number[]; client: string; surface: string; maxBytes: number; maxDurationSeconds: number; timingProvenance: string };
}
export interface DesktopRecording {
  sha256: string; byteSize: number; contentType: string; recordedDurationMs: number; interrupted: boolean;
  desktopContext: { schemaVersion: 1; installationId: string; appVersion: string; platform: 'win32' | 'darwin'; captureStartedAt: string; captureEndedAt: string; cameraLabel?: string; offline: boolean };
}
export interface UploadParts { partSize: number; maxParts: number; parts: Array<{ partNumber: number; byteSize: number; sha256: string }> }
export interface PartReceipt { partNumber: number; sha256: string; byteSize: number }
interface RequestOptions { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; bytes?: Uint8Array; signal?: AbortSignal; idempotencyKey?: string; auth?: boolean; timeout?: number; range?: string }
const id = (value: string) => encodeURIComponent(value);

/** Main-process-only transport. No arbitrary endpoint is exposed to renderer IPC. */
export class DesktopApi {
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: { config: DesktopConfig; getToken: (forceRefresh?: boolean) => Promise<string | null>; getAccountId: () => string | null; fetch?: typeof fetch }) { this.fetcher = options.fetch ?? fetch; }
  assertAccount(accountId: string): void {
    if (!accountId || this.options.getAccountId() !== accountId) throw new DesktopApiError('SESSION_CHANGED', 'Sign in to the account that recorded this evidence.', 401);
  }
  private async response(path: string, options: RequestOptions = {}): Promise<Response> {
    const accountId = options.auth === false ? null : this.options.getAccountId();
    if (options.auth !== false && !accountId) throw new DesktopApiError('UNAUTHENTICATED', 'Sign in to PackProof.', 401);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout ?? 30_000)]) : AbortSignal.timeout(options.timeout ?? 30_000);
    const requestId = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      if (accountId) this.assertAccount(accountId);
      const token = options.auth === false ? null : await this.options.getToken(attempt > 0);
      if (accountId) this.assertAccount(accountId);
      const headers: Record<string, string> = { Accept: 'application/json', 'X-Request-ID': requestId, 'X-PackProof-Intake-Version': '1' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (options.bytes) headers['Content-Type'] = 'application/octet-stream';
      if (options.range) headers.Range = options.range;
      const response = await this.fetcher(`${this.options.config.apiBaseUrl}${path}`, { method: options.method ?? 'GET', headers, redirect: 'error', signal, body: options.bytes ? new Uint8Array(options.bytes) : options.body === undefined ? undefined : JSON.stringify(options.body) });
      if (accountId) this.assertAccount(accountId);
      if (response.status === 401 && attempt === 0 && accountId) { await response.body?.cancel(); continue; }
      if (!response.ok) {
        const value = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
        throw new DesktopApiError(value.error?.code ?? 'HTTP_ERROR', value.error?.message ?? `PackProof request failed (${response.status}).`, response.status);
      }
      return response;
    }
    throw new DesktopApiError('UNAUTHENTICATED', 'Your session expired. Sign in again.', 401);
  }
  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const accountId = this.options.getAccountId();
    const response = await this.response(path, options);
    if (response.status === 204) return undefined as T;
    const result = await response.json() as T;
    if (options.auth !== false && accountId) this.assertAccount(accountId);
    return result;
  }
  getMe(signal?: AbortSignal): Promise<ProfileView> { return this.request('/me', { signal }); }
  updateProfile(input: { username?: string; displayName?: string }): Promise<ProfileView> { return this.request('/me/profile', { method: 'PATCH', body: input }); }
  getCapabilities(signal?: AbortSignal): Promise<DesktopCapabilities> { return this.request('/capabilities', { auth: false, signal }); }
  async listProofs(input: { view?: 'all' | 'attention' | 'completed'; q?: string; signal?:AbortSignal; maxPages?:number } = {}): Promise<ProofCollectionItem[]> {
    const result = new Map<string, ProofCollectionItem>();
    let offset: number | null = 0;
    const accountId = this.options.getAccountId();
    let pages=0;
    while (offset !== null) {
      input.signal?.throwIfAborted();
      if(input.maxPages!==undefined&&++pages>input.maxPages)throw new DesktopApiError('POLL_PAGE_LIMIT','Attention monitoring will retry later. Open Proofs to review the full list.',502);
      if (!accountId) throw new DesktopApiError('UNAUTHENTICATED', 'Sign in to PackProof.', 401);
      this.assertAccount(accountId);
      const query: URLSearchParams = new URLSearchParams({ view: input.view ?? 'all', q: input.q ?? '', limit: '100', offset: String(offset) });
      const page: { proofs: ProofCollectionItem[]; nextOffset?: number | null } = await this.request(`/me/proofs?${query}`,{signal:input.signal});
      for (const proof of page.proofs) result.set(proof.proofId, proof);
      const next: number | null = page.nextOffset ?? null;
      if (next !== null && (!Number.isSafeInteger(next) || next <= offset)) throw new DesktopApiError('INVALID_PAGINATION', 'PackProof returned an incomplete Proof list. Try again.', 502);
      offset = next;
    }
    return [...result.values()];
  }
  getOnboarding():Promise<OnboardingState>{return this.request('/me/onboarding');}
  updateOnboarding(action:Action):Promise<OnboardingState>{return this.request('/me/onboarding',{method:'POST',body:action});}
  getProof(proofId: string, signal?: AbortSignal): Promise<CanonicalProof> { return this.request(`/proofs/${id(proofId)}`, { signal }); }
  /** Creation isn't blindly retried: this legacy backend route has no transaction-create idempotency contract. */
  createProof(input: TransactionWriteInput): Promise<CanonicalProof> { return this.request('/proofs', { method: 'POST', body: { workflowType: 'COMMERCE_SALE', transaction: input } }); }
  async listOrders(filter: 'ready' | 'completed' | 'all' = 'all'): Promise<FulfillmentQueueItem[]> { return (await this.request<{ items: FulfillmentQueueItem[] }>(`/me/fulfillment-queue?filter=${filter}`)).items; }
  resolvePackingStation(reference: string): Promise<PackingStationResolveView> { return this.request('/me/packing-station/resolve', { method: 'POST', body: { reference } }); }
  listConnectedAccounts(): Promise<ConnectedAccountsListView> { return this.request('/me/connected-accounts'); }
  listCommerceConnections(signal?:AbortSignal): Promise<{ connections: CommerceConnectionView[] }> { return this.request('/me/integration-connections?capability=commerce',{signal}); }
  syncCommerceConnection(connectionId: string): Promise<CommerceSyncView> { return this.request(`/me/commerce-connections/${id(connectionId)}/sync`, { method: 'POST', body: {} }); }
  startConnectedAccountConnect(provider: string, input: { shop?: string } = {}): Promise<{ authorizationUrl: string; expiresAt: string; provider: string }> { return this.request(`/me/connected-accounts/${id(provider)}/connect`, { method: 'POST', body: input }); }
  getShipmentIntegrity(proofId: string): Promise<ShipmentIntegrityView> { return this.request(`/proofs/${id(proofId)}/shipment-integrity`); }
  previewSharedProof(proofId: string): Promise<PublicProofView> { return this.request(`/proofs/${id(proofId)}/disclosure/preview`, { method: 'POST', body: { purpose: 'SHARED_PROOF' } }); }
  /** The caller must display the preview and obtain explicit approval before submitting its hash. */
  createSharedProofLink(proofId: string, input: { previewHash: string; originalsReviewed: true; expiresAt: string }): Promise<AccessLinkView> {
    if (input.originalsReviewed !== true || !/^[a-f0-9]{64}$/.test(input.previewHash) || !Number.isFinite(Date.parse(input.expiresAt))) throw new DesktopApiError('DISCLOSURE_REVIEW_REQUIRED', 'Review the Proof and approve sharing its original recordings before creating a link.', 400);
    return this.request(`/proofs/${id(proofId)}/disclosure/grants`, { method: 'POST', body: { purpose: 'SHARED_PROOF', originalsReviewed: true, previewHash: input.previewHash, expiresAt: input.expiresAt } });
  }
  revokeAccessLink(proofId: string, accessLinkId: string): Promise<void> { return this.request(`/proofs/${id(proofId)}/access-links/${id(accessLinkId)}`, { method: 'DELETE' }); }
  getManifest(proofId: string, signal?: AbortSignal): Promise<ManifestView> { return this.request(`/proofs/${id(proofId)}/manifest`, { signal }); }
  /** Stream to a native file; response is never sent across IPC. */
  exportProofPackage(proofId: string, signal?: AbortSignal): Promise<Response> { return this.response(`/proofs/${id(proofId)}/package`, { signal, timeout: 600_000 }); }
  getEvidence(proofId: string, evidenceId: string, signal?: AbortSignal, range?: string, stageId?: string): Promise<Response> {
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw new DesktopApiError('INVALID_RANGE', 'Unsupported media byte range.', 416);
    const path = stageId ? `/proofs/${id(proofId)}/lifecycle/stages/${id(stageId)}/evidence/${id(evidenceId)}` : `/proofs/${id(proofId)}/evidence/${id(evidenceId)}`;
    return this.response(path, { signal, range, timeout: 600_000 });
  }
  registerDesktopRecording(proofId: string, idempotencyKey: string, input: DesktopRecording, signal?: AbortSignal): Promise<CaptureSession> { return this.request(`/proofs/${id(proofId)}/capture-sessions/desktop-registration`, { method: 'POST', idempotencyKey, body: input, signal }); }
  completeCaptureSession(proofId: string, sessionId: string, input: { sha256: string; byteSize: number; contentType: string; interrupted?: boolean; recordedDurationMs?: number }, signal?: AbortSignal): Promise<CaptureSession> { return this.request(`/proofs/${id(proofId)}/capture-sessions/${id(sessionId)}/complete`, { method: 'POST', body: input, signal }); }
  recoverCaptureSession(proofId: string, sessionId: string, signal?: AbortSignal): Promise<CaptureSession> { return this.request(`/proofs/${id(proofId)}/capture-sessions/${id(sessionId)}/recover`, { method: 'POST', body: {}, signal }); }
  cancelCaptureSession(proofId: string, sessionId: string, signal?: AbortSignal): Promise<{ cancelled: boolean }> { return this.request(`/proofs/${id(proofId)}/capture-sessions/${id(sessionId)}/cancel`, { method: 'POST', body: {}, signal }); }
  initializeEvidenceUpload(proofId: string, input: { contentType: string; evidenceType?: string; idempotencyKey: string; captureSessionId: string; byteSize: number }, signal?: AbortSignal): Promise<EvidenceUploadView> { const { idempotencyKey, ...body } = input; return this.request(`/proofs/${id(proofId)}/evidence/uploads`, { method: 'POST', idempotencyKey, body: { ...body, evidenceType: input.evidenceType ?? 'FULFILLMENT_CAPTURE' }, signal }); }
  async listUploadParts(proofId: string, evidenceId: string, signal?: AbortSignal): Promise<UploadParts> {
    const result = await this.request<UploadParts>(`/proofs/${id(proofId)}/evidence/${id(evidenceId)}/parts`, { signal });
    return { ...result, parts: result.parts.map(part => ({ ...part, byteSize: Number(part.byteSize) })) };
  }
  uploadPart(proofId: string, evidenceId: string, partNumber: number, bytes: Uint8Array, signal?: AbortSignal): Promise<PartReceipt> { return this.request(`/proofs/${id(proofId)}/evidence/${id(evidenceId)}/parts/${partNumber}`, { method: 'PUT', bytes, signal, timeout: 120_000 }); }
  completeUploadParts(proofId: string, evidenceId: string, totalBytes: number, signal?: AbortSignal): Promise<{ sha256: string; byteSize: number; readyToCommit: boolean }> { return this.request(`/proofs/${id(proofId)}/evidence/${id(evidenceId)}/parts/complete`, { method: 'POST', body: { totalBytes }, signal, timeout: 120_000 }); }
  commitEvidence(proofId: string, evidenceId: string, sha256: string, signal?: AbortSignal): Promise<{ proof: CanonicalProof; sha256: string; evidenceId: string }> { return this.request(`/proofs/${id(proofId)}/evidence/${id(evidenceId)}/commit`, { method: 'POST', body: { sha256 }, signal, timeout: 120_000 }); }
  discardUpload(proofId: string, evidenceId: string, signal?: AbortSignal): Promise<{ discarded: boolean }> { return this.request(`/proofs/${id(proofId)}/evidence/discard`, { method: 'POST', body: { evidenceId }, signal }); }
  createAttestation(proofId: string, input: { statement: string; relatedEvidenceId: string }, signal?: AbortSignal): Promise<{ proof: CanonicalProof }> { return this.request(`/proofs/${id(proofId)}/attestations`, { method: 'POST', body: input, signal }); }
  finalizeProof(proofId: string, signal?: AbortSignal): Promise<{ proof: CanonicalProof; manifest?: ManifestView }> { return this.request(`/proofs/${id(proofId)}/finalize`, { method: 'POST', body: {}, signal }); }
  bindCaptureShipping(proofId: string, sessionId: string, input: { rawValue: string; format: string; detectedAtMs: number; idempotencyKey: string; confirmed?: boolean }, signal?: AbortSignal): Promise<{ status: string; trackingNumber?: string; observationId?: string }> { return this.request(`/proofs/${id(proofId)}/capture-sessions/${id(sessionId)}/shipping-label`, { method: 'POST', body: input, signal }); }
  resolveCaptureShippingObservation(proofId: string, sessionId: string, observationId: string, signal?: AbortSignal): Promise<{ reviewRequired: boolean }> { return this.request(`/proofs/${id(proofId)}/capture-sessions/${id(sessionId)}/shipping-observations/${id(observationId)}/resolve`, { method: 'POST', body: { decision: 'NOT_THIS_PACKAGE', reason: 'The operator reviewed this label and confirmed that it belongs to another package.' }, signal }); }
  getCaptureShippingReview(proofId: string, sessionId: string, signal?: AbortSignal): Promise<{ reviewRequired: boolean }> { return this.request(`/proofs/${id(proofId)}/capture-sessions/${id(sessionId)}/shipping-observations`, { signal }); }
}
