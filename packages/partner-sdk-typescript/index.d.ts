export interface RequestOptions { method?: string; body?: unknown; idempotencyKey?: string; ifMatch?: string; signal?: AbortSignal }
export interface MutationOptions extends RequestOptions { idempotencyKey: string }
export interface RevisionOptions extends MutationOptions { revision: number }
export interface RecordChildPageOptions { cursor?: string; limit?: number; signal?: AbortSignal }
export interface RecordChildIterationOptions extends RecordChildPageOptions { maxPages?: number }
/** Responses can add enum values without a client upgrade; do not exhaustively adjudicate unknown states. */
export type OpenEnum<T extends string> = T | (string & {});
export interface ApiResponse<T = unknown> { data: T; rawBody: string; status: number; headers: Headers; requestId: string | null; replayed: boolean }
export interface Problem { code?: string; title?: string; detail?: string; status?: number; [key: string]: unknown }
export interface ProofPage { proofIds: string[]; nextCursor: string; hasMore: boolean; cursorExpiresAt: string; [key: string]: unknown }
export interface Event { id: string; type: string; apiVersion: string; tenantId: string; createdAt: string; data: { proofId: string; [key: string]: unknown }; streamSequence?: string; [key: string]: unknown }
export interface EventPage { events: Event[]; nextCursor: string; highWaterMark: string; hasMore: boolean; cursorExpiresAt: string; [key: string]: unknown }
export interface CreateProofInput { integrationAccountId: string; externalId: string; operatorMembershipId: string; transaction: { itemTitle: string; itemDescription?: string; quantity?: number; shipping?: { carrier?: string; service?: string; trackingNumber?: string; shipmentDate?: string }; amount?: { minorUnits: string; currency: string } } }
export interface ProofReceipt { proofId: string; externalId: string; created: boolean; recordRevision?: number; portalPath?: string; [key: string]: unknown }
export type CursorPage<K extends string, T> = { nextCursor: string | null; hasMore: boolean } & Record<K, T[]>;
export interface PartnerLimits { schema: 'packproof.partner-limits/v1'; profile: 'packproof.partner/v1'; merchantId: string; environment: 'sandbox' | 'live'; effectiveScopes: string[]; limits: Record<string, unknown>; capabilities: { humanAttestationRequired: true; automaticConnectorCatalog: string; auditRead: boolean; connectionAdministration: false }; [key: string]: unknown }
export interface PartnerConnection { id: string; provider: string; state: string; label: string; action: string; createdAt: string; lastSuccessfulSyncAt: string | null; lastWatermarkCheckAt: string | null; expectedIntervalSeconds: number | null; errorCode: string | null; mappingVersion: null; capability: OpenEnum<'one_time_import' | 'pilot'>; capabilities: { automaticSync: false; manage: false }; [key: string]: unknown }
export interface PartnerAuditEvent { id: string; actorUserId: string | null; principalId: string | null; credentialId: string | null; delegationId: string | null; requestId: string; operation: string; resourceId: string | null; policyVersion: string; createdAt: string; [key: string]: unknown }
export interface WebhookDelivery { id: string; webhookId: string; eventId: string; proofId: string; eventType: string; state: OpenEnum<'pending' | 'sending' | 'delivered' | 'dead'>; attempts: number; nextAttemptAt: string | null; lastStatus: number | null; deliveredAt: string | null; eventCreatedAt: string; replays: { id: string; priorAttemptCount: number; reason: string; requestedAt: string }[]; [key: string]: unknown }
export interface WebhookReplay { replayId: string; deliveryId: string; webhookId: string; eventId: string; proofId: string; state: 'pending'; priorAttemptCount: number; reason: string; requestedAt: string; signatureTimestamp: 'generated_at_dispatch'; [key: string]: unknown }
export type ShipmentEventType = 'LABEL_CREATED' | 'CARRIER_ACCEPTED' | 'WEIGHT_RECORDED' | 'IN_TRANSIT' | 'ARRIVED_AT_FACILITY' | 'DEPARTED_FACILITY' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'DELIVERY_EXCEPTION' | 'RETURN_TO_SENDER' | 'RETURN_IN_TRANSIT' | 'RETURN_DELIVERED' | 'CARRIER_EVENT';
export interface SourceObservationInput { sourceEventId: string; proofId: string; eventType: ShipmentEventType; reportedAt: string; carrier?: string | null; location?: string | null; data?: Record<string, unknown> }
export interface SourceIngestionInput { connectionId: string; events: SourceObservationInput[] }
export interface SourceIngestionReceipt { operationId: string; state: OpenEnum<'queued' | 'failed'>; receivedAt: string; itemCount: number; links: { self: string }; sourceAssurance: 'organization_submitted'; replayed: boolean; [key: string]: unknown }
export interface SourceOperationItem { itemIndex: number; sourceEventId: string; proofId: string; reportedAt: string; receivedAt: string; status: OpenEnum<'queued' | 'imported' | 'duplicate' | 'conflict' | 'failed'>; eventId: string | null; errorCode: string | null; attempts: number; [key: string]: unknown }
export interface SourceOperation { operationId: string; state: OpenEnum<'queued' | 'running' | 'succeeded' | 'partially_succeeded' | 'failed'>; receivedAt: string; updatedAt: string; itemCount: number; links: { self: string }; items: SourceOperationItem[]; sourceAssurance: 'organization_submitted'; [key: string]: unknown }
export interface ShippingRecordSummary {
  id: string; proofId: string; organizationId: string; environment: 'sandbox' | 'live';
  reference: string | null; title: string | null; trackingNumber: string | null; carrier: string | null;
  createdAt: string; updatedAt: string; revision: number; lifecycle: OpenEnum<'open' | 'closed'>; sample: false;
  locationId: string | null; sourceName: string;
  coverage: { satisfied: number; total: number; waived: number; missing: number; notYetDue: number };
  integrity: OpenEnum<'not_sealed' | 'sealed'>; review: OpenEnum<'needs_attention' | 'reviewed' | 'unreviewed'>; issueCount: number;
  [key: string]: unknown;
}
export interface RecordTimelineEvent { id: string; type: string; reportedAt: string | null; receivedAt: string; source: string; actorId: string | null; subjectId: string; data: Record<string, unknown>; [key: string]: unknown }
export interface RecordEvidence { id: string; type: string; contentType: string; byteSize: number | null; sha256: string | null; state: OpenEnum<'available' | 'pending' | 'rejected'>; receivedAt: string; reportedAt: string | null; source: string; subjectIds: string[]; original: true; [key: string]: unknown }
export interface RecordRequirement { id: string; subjectId: string; stage: string; title: string; templateVersion: string; acceptedEvidenceTypes: string[]; dueAt: string | null; gracePeriodMs: number; status: OpenEnum<'satisfied' | 'missing' | 'not_yet_due' | 'waived'>; evidenceIds: string[]; waiver: null | { id: string; reason: string; actorId: string; createdAt: string }; [key: string]: unknown }
export interface RecordIssue { id: string; proofId: string; category: string; severity: OpenEnum<'info' | 'warning' | 'critical'>; title: string; subjectId: string; ruleVersion: string; comparedSources: unknown; status: OpenEnum<'open' | 'acknowledged' | 'resolved'>; createdAt: string; updatedAt: string; actions: { id: string; action: string; reason: string; actorId: string; createdAt: string }[]; [key: string]: unknown }
export interface RecordTimelinePage { timeline: RecordTimelineEvent[]; nextCursor: string | null; hasMore: boolean; [key: string]: unknown }
export interface RecordEvidencePage { evidence: RecordEvidence[]; nextCursor: string | null; hasMore: boolean; [key: string]: unknown }
export interface ShippingRecordDetail { schema: 'packproof.records/v1'; record: ShippingRecordSummary; timeline: RecordTimelineEvent[]; evidence: RecordEvidence[]; timelineNextCursor: string | null; evidenceNextCursor: string | null; requirements: RecordRequirement[]; issues: RecordIssue[]; relationships: Record<string, unknown>[]; assurance: { coreManifest: 'present' | 'absent'; operationalView: 'not_a_signed_snapshot'; physicalCondition: 'not_established'; explanation: string }; sourceHealth: { state: string; message: string }; capabilities: { edit: boolean; review: boolean; waive: boolean; export: boolean; downloadOriginal: boolean; capture: boolean; operationalSnapshots: false; [key: string]: unknown }; [key: string]: unknown }
export interface RecordCommandReceipt { proofId: string; revision: number; id?: string; lifecycle?: OpenEnum<'open' | 'closed'>; [key: string]: unknown }
export interface ClientOptions { baseUrl: string; token: string; merchantId?: string; delegationId?: string; timeoutMs?: number; maxAttempts?: number; fetch?: typeof globalThis.fetch; sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>; allowInsecureLocalhost?: boolean }
export declare class PackProofError extends Error { status: number; requestId: string | null; body: unknown; headers: Headers; code: string | null; constructor(message: string, details?: { status?: number; requestId?: string | null; body?: unknown; headers?: Headers; cause?: unknown }) }
export declare class PackProofClient {
  constructor(options: ClientOptions);
  request<T = unknown>(path: string, options?: RequestOptions): Promise<ApiResponse<T>>;
  createProof(input: CreateProofInput, options: MutationOptions): Promise<ApiResponse<ProofReceipt>>;
  getProof<T = unknown>(proofId: string, options?: RequestOptions): Promise<ApiResponse<T>>;
  getRecord<T = ShippingRecordDetail>(proofId: string, options?: RequestOptions): Promise<ApiResponse<T>>;
  getTimeline<T = RecordTimelinePage>(proofId: string, options?: RecordChildPageOptions): Promise<ApiResponse<T>>;
  getEvidence<T = RecordEvidencePage>(proofId: string, options?: RecordChildPageOptions): Promise<ApiResponse<T>>;
  getRequirements<T = RecordRequirement>(proofId: string, options?: RequestOptions): Promise<ApiResponse<{ requirements: T[] }>>;
  updateRecord<T = RecordCommandReceipt>(proofId: string, input: { title?: string | null; reference?: string | null; locationId?: string | null; reason: string }, options: RevisionOptions): Promise<ApiResponse<T>>;
  closeRecord<T = RecordCommandReceipt>(proofId: string, reason: string, options: RevisionOptions): Promise<ApiResponse<T>>;
  reopenRecord<T = RecordCommandReceipt>(proofId: string, reason: string, options: RevisionOptions): Promise<ApiResponse<T>>;
  appendAmendment<T = RecordCommandReceipt>(proofId: string, input: { supersedesId: string; assertion: Record<string, unknown>; reason: string }, options: RevisionOptions): Promise<ApiResponse<T>>;
  appendEntity<T = RecordCommandReceipt>(proofId: string, input: { kind: 'shipment' | 'stop' | 'package' | 'pallet' | 'item' | 'return'; externalReference?: string; parentId?: string; attributes?: Record<string, unknown>; supersedesId?: string; reason: string }, options: RevisionOptions): Promise<ApiResponse<T>>;
  linkEvidence<T = RecordCommandReceipt>(proofId: string, input: { evidenceId: string; subjectId: string; reason: string }, options: RevisionOptions): Promise<ApiResponse<T>>;
  listProofs(options?: { after?: string; signal?: AbortSignal }): Promise<ApiResponse<ProofPage>>;
  resolveProof(integrationAccountId: string, externalId: string, options?: RequestOptions): Promise<ApiResponse<{ proofId: string }>>;
  requestCapture<T = unknown>(proofId: string, input: { allowedSurfaces?: ('WEB' | 'ANDROID')[] }, options: MutationOptions): Promise<ApiResponse<T>>;
  listEvents(options?: { after?: string; limit?: number; signal?: AbortSignal }): Promise<ApiResponse<EventPage>>;
  createWebhook(input: { url: string; eventTypes: string[] }, options: MutationOptions): Promise<ApiResponse<{ id: string; url: string; eventTypes: string[]; secret: string }>>;
  listWebhooks(options?: RequestOptions): Promise<ApiResponse<{ webhooks: unknown[] }>>;
  revokeWebhook(webhookId: string, options: MutationOptions): Promise<ApiResponse<{ id: string; revoked: boolean }>>;
  getLimits(options?: RequestOptions): Promise<ApiResponse<PartnerLimits>>;
  listIssues(options?: RecordChildPageOptions & { status?: 'unresolved' | 'open' | 'acknowledged' | 'resolved' | 'all'; proofId?: string }): Promise<ApiResponse<CursorPage<'issues', RecordIssue>>>;
  actOnIssue(issueId: string, input: { action: 'acknowledge' | 'resolve' | 'reopen' | 'note'; reason: string }, options: RevisionOptions): Promise<ApiResponse<RecordCommandReceipt>>;
  listConnections(options?: RecordChildPageOptions): Promise<ApiResponse<CursorPage<'connections', PartnerConnection>>>;
  listAuditEvents(options?: RecordChildPageOptions & { operation?: string; resourceId?: string; from?: string; to?: string }): Promise<ApiResponse<CursorPage<'events', PartnerAuditEvent>>>;
  listWebhookDeliveries(options?: RecordChildPageOptions & { state?: 'pending' | 'sending' | 'delivered' | 'dead'; webhookId?: string }): Promise<ApiResponse<CursorPage<'deliveries', WebhookDelivery>>>;
  replayWebhookDelivery(deliveryId: string, reason: string, options: MutationOptions): Promise<ApiResponse<WebhookReplay>>;
  createIngestion(input: SourceIngestionInput, options: MutationOptions): Promise<ApiResponse<SourceIngestionReceipt>>;
  getOperation(operationId: string, options?: RequestOptions): Promise<ApiResponse<SourceOperation>>;
  waitForOperation(operationId: string, options?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<ApiResponse<SourceOperation>>;
  proofIds(options?: { after?: string; maxPages?: number; signal?: AbortSignal }): AsyncGenerator<string>;
  eventPages(options?: { after?: string; limit?: number; maxPages?: number; signal?: AbortSignal }): AsyncGenerator<ApiResponse<EventPage>>;
  timelinePages(proofId: string, options?: RecordChildIterationOptions): AsyncGenerator<ApiResponse<RecordTimelinePage>>;
  evidencePages(proofId: string, options?: RecordChildIterationOptions): AsyncGenerator<ApiResponse<RecordEvidencePage>>;
  pollOperation<T = { state: string; [key: string]: unknown }>(path: string, options?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<ApiResponse<T>>;
}
export declare function verifyWebhook(options: { secret: string; signature: string; rawBody: string | Uint8Array; nowSeconds?: number; toleranceSeconds?: number }): boolean;
