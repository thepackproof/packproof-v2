export type ProofStatus =
  | "OPEN"
  | "AWAITING_PARTICIPANT"
  | "READY_FOR_EVIDENCE"
  | "EVIDENCE_COMMITTED"
  | "FINALIZED";

export interface ShippingView {
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  shipmentDate: string | null;
}

export interface TransactionItemView {
  itemId: string | null;
  externalItemId: string | null;
  position: number;
  title: string | null;
  description: string | null;
  sku: string | null;
  quantity: number | null;
  unitValue: number | null;
  currency: string | null;
}

export interface TransactionView {
  transactionId: string;
  externalReference: string | null;
  transactionDate: string | null;
  itemTitle: string | null;
  itemDescription: string | null;
  quantity: number | null;
  transactionValue: number | null;
  currency: string | null;
  items?: TransactionItemView[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  metadata: unknown;
  shipping: ShippingView | null;
  proofId: string | null;
  proofStatus: string | null;
  sellerUserId: string;
  buyerUserId: string | null;
  provenance?: {
    source: string;
    adapterKey: string;
    provider: string;
    tenantKey: string;
    externalTransactionId: string;
    sourceRecordId: string | null;
    importedAt: string;
    payloadSha256: string | null;
    buyer: {
      externalId: string | null;
      displayName: string | null;
      email: string | null;
    } | null;
  } | null;
}

export interface TransactionWriteInput {
  externalReference?: string | null;
  transactionDate?: string | null;
  itemTitle?: string | null;
  itemDescription?: string | null;
  quantity?: number | null;
  transactionValue?: number | null;
  currency?: string | null;
  metadata?: unknown;
  shipping?: {
    carrier?: string | null;
    service?: string | null;
    trackingNumber?: string | null;
    shipmentDate?: string | null;
  } | null;
}

export interface ShippingWriteInput {
  carrier?: string | null;
  service?: string | null;
  trackingNumber?: string | null;
  shipmentDate?: string | null;
}

export interface ShipmentEventView {
  id: string;
  proofId: string;
  transactionId: string;
  shippingId?: string;
  eventType: string;
  occurredAt: string;
  observedAt: string;
  source: string;
  provider: string;
  carrier: string | null;
  location: string | null;
  eventData: Record<string, unknown>;
  sha256: string;
  contentSha256?: string;
  previousEventSha256?: string | null;
  coreManifestSha256?: string | null;
  payloadSha256?: string | null;
  sourceEventId: string | null;
}

export interface ChronologyEntry {
  id: string;
  occurredAt: string;
  category: "PROOF" | "COMMERCE" | "SHIPMENT" | string;
  title: string;
  description: string | null;
  source: string;
  provider?: string | null;
  relatedEntityId: string | null;
  eventType: string;
}

export interface ShipmentImportView {
  transactionId: string;
  proofId: string;
  events: ShipmentEventView[];
  createdCount: number;
}

export interface ShipmentSyncView {
  transactionId: string;
  proofId: string;
  connectionId: string;
  adapterKey: string;
  provider: string;
  createdCount: number;
  eventCount: number;
  events: ShipmentEventView[];
  replayed: boolean;
}

export interface ShipmentIntegrityVerification {
  coreManifestValid: boolean;
  eventContentHashesValid: boolean;
  eventChainValid: boolean;
  supplementValid: boolean;
  linkedToFinalizedProof: boolean;
  valid: boolean;
}

export interface ShipmentIntegrityView {
  schema?: "packproof.shipment.integrity/v1" | string;
  status: "LINKED" | "CORE_NOT_FINALIZED" | "NO_SHIPMENT" | string;
  algorithm?: string;
  proofId: string;
  transactionId: string;
  shippingId: string | null;
  coreManifestSha256: string | null;
  shipmentSupplementSha256: string | null;
  eventCount: number;
  firstEventSha256: string | null;
  latestEventSha256: string | null;
  supplement: {
    schema?: string;
    proofId: string;
    transactionId: string;
    coreManifestSha256: string;
    shipment: {
      shippingId: string;
      carrier: string | null;
      service: string | null;
      trackingNumber: string | null;
      shipmentDate: string | null;
    };
    events: Array<{ shipmentEventId: string; sha256: string }>;
  } | null;
  verification: ShipmentIntegrityVerification;
}

export interface ProofView {
  schema?: "packproof.proof.canonical/v1" | string;
  proofId: string;
  transactionId: string;
  status: ProofStatus | string;
  participationPolicy?: "COUNTERPARTY_REQUIRED" | "COUNTERPARTY_OPTIONAL" | string;
  version: number;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  manifestId: string | null;
  identity?: {
    proofId: string;
    transactionId: string;
    status: string;
    version: number;
    createdAt: string;
    finalizedAt: string | null;
  };
  transaction: TransactionView;
  participants: Array<{
    participantId: string;
    userId: string;
    role: string;
    status: "JOINED" | string;
    invitationState?: string;
    authorization?: string;
    joinedAt: string;
  }>;
  invitations?: Array<{
    invitationId: string;
    inviteeIdentifier: string;
    inviteeUserId: string | null;
    status: string;
    createdAt: string;
    acceptedAt: string | null;
    expiresAt: string | null;
  }>;
  evidence: Array<{
    evidenceId: string;
    evidenceType: string;
    validationStatus: string;
    submittedBy?: string;
    createdAt?: string;
    receivedAt?: string;
    sha256: string | null;
    byteSize: number | null;
    committedAt: string | null;
    objectKey?: string;
    contentType?: string;
    digest?: { algorithm: string; sha256: string } | null;
  }>;
  attestations?: Array<{
    kind: "ATTESTATION" | string;
    attestationId: string;
    attestedBy: string;
    statement: string;
    relatedEvidenceId: string | null;
    createdAt: string;
    digest: { algorithm: string; sha256: string };
  }>;
  events?: Array<{
    eventId: string;
    eventType: string;
    actorUserId: string | null;
    at: string;
    data: Record<string, unknown>;
  }>;
  facts?: Array<{
    kind: "FACT" | string;
    name: string;
    at: string;
    data: Record<string, unknown>;
  }>;
  external?: {
    records: Array<{
      kind: "EXTERNAL" | string;
      field: string;
      value: unknown;
      source: string;
      verifiedByPackProof: boolean;
    }>;
    references: Array<{
      tenantKey: string;
      externalTransactionId: string;
      source: string;
    }>;
  };
  integrity?: {
    algorithm: string;
    evidence: Array<{ evidenceId: string; sha256: string }>;
    manifestSha256: string | null;
  };
  shipmentObservations?: {
    shippingId: string | null;
    identity: ShippingView | null;
    events: ShipmentEventView[];
    latest: ShipmentEventView | null;
  };
  chronology?: ChronologyEntry[];
  shipmentSync?: {
    available: boolean;
    connectionId: string | null;
    adapterKey: string | null;
    provider: string | null;
    status: string | null;
  };
}

export interface InvitationView {
  invitationId: string;
  proofId: string;
  inviteeIdentifier: string;
  inviteeUserId?: string | null;
  status: string;
  token: string;
  createdAt: string;
  acceptedAt: string | null;
  expiresAt: string | null;
}

export interface ProfileView {
  userId: string;
  username: string | null;
  displayName: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export type ProofInvitationState = "NONE" | "SELF" | "PARTICIPANT" | "INVITED" | "INELIGIBLE";

export interface PublicProfileView {
  userId: string;
  username: string;
  displayName: string | null;
  invitationState?: ProofInvitationState;
}

export interface InvitationInboxView {
  invitationId: string;
  proofId: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  inviter: {
    userId: string;
    username: string | null;
    displayName: string | null;
  };
  transaction: {
    transactionId: string;
    itemTitle: string | null;
    externalReference: string | null;
  };
}

export interface ProofCollectionItem {
  schema?: "packproof.proof.summary/v1" | string;
  proofId: string;
  transactionId: string;
  role: "SELLER" | "BUYER" | string;
  status: ProofStatus | string;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  transaction: {
    externalReference: string | null;
    itemTitle: string | null;
    transactionDate: string | null;
    carrier: string | null;
    trackingNumber: string | null;
  };
}

export interface ManifestView {
  manifestId: string;
  proofId: string;
  sha256: string;
  canonicalJson: string;
  manifest: unknown;
}

export interface UploadTarget {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
}

export interface EvidenceUploadView {
  evidenceId: string;
  proofId: string;
  objectKey: string;
  contentType: string;
  evidenceType: string;
  validationStatus: string;
  upload: UploadTarget;
}

export interface TransactionImportView {
  transaction: TransactionView;
  proof: ProofView | null;
  identity: {
    adapterKey: string;
    tenantKey: string;
    externalTransactionId: string;
    source: string;
  };
  created: boolean;
}

export interface IntegrationConnectionView {
  connectionId: string;
  adapterKey: string;
  provider: string;
  providerDisplay: string;
  externalAccountReference: string | null;
  status: string;
  lastSyncAt: string | null;
  lastErrorCode: string | null;
  retryable: boolean;
  readyOrderCount: number;
}

export interface FulfillmentQueueItem {
  transactionId: string;
  proofId: string;
  providerDisplay: string;
  externalOrderId: string;
  externalReference: string | null;
  itemSummary: string;
  itemCount: number;
  proofStatus: string;
  participationPolicy: string;
  evidenceCount: number;
  pendingEvidenceCount: number;
  fulfillmentCaptureCount?: number;
  canComplete: boolean;
  workflowState: string;
}

export interface PackingStationResolveView {
  schema?: string;
  reference: string;
  matchedBy: string;
  transactionId: string;
  proofId: string | null;
  proofStatus: string | null;
  participationPolicy: string | null;
  orderLabel: string;
  itemSummary: string;
  trackingHint?: string | null;
  committedEvidenceCount: number;
  captureReady: boolean;
  alreadyFinalized: boolean;
  alreadyHasCommittedEvidence: boolean;
  blockReason: string | null;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export class PackProofV2Client {
  constructor(
    private readonly options: {
      baseUrl: string;
      getToken: () => string | null;
    },
  ) {}

  async login(subject: string): Promise<{ userId: string; token: string }> {
    return this.request("/auth/dev/login", {
      method: "POST",
      auth: false,
      body: { subject },
    });
  }

  async getMe(): Promise<ProfileView> {
    return this.request("/me");
  }

  async updateProfile(input: {
    username?: string;
    displayName?: string;
  }): Promise<ProfileView> {
    return this.request("/me/profile", {
      method: "PATCH",
      body: input,
    });
  }

  async searchUsers(query: string): Promise<{ users: PublicProfileView[] }> {
    return this.request(`/users/search?q=${encodeURIComponent(query)}`);
  }

  async searchProofUsers(
    proofId: string,
    query: string,
  ): Promise<{ users: PublicProfileView[] }> {
    return this.request(
      `/proofs/${encodeURIComponent(proofId)}/users/search?q=${encodeURIComponent(query)}`,
    );
  }

  async listInvitations(): Promise<{ invitations: InvitationInboxView[] }> {
    return this.request("/invitations");
  }

  async listMyProofs(): Promise<{ proofs: ProofCollectionItem[] }> {
    return this.request("/me/proofs");
  }

  async listIntegrationConnections(
    capability?: "commerce" | string,
  ): Promise<{ connections: IntegrationConnectionView[] }> {
    const query = capability ? `?capability=${encodeURIComponent(capability)}` : "";
    return this.request(`/me/integration-connections${query}`);
  }

  async listFulfillmentQueue(
    filter: "ready" | "completed" | "all" = "ready",
  ): Promise<{ items: FulfillmentQueueItem[]; filter: string }> {
    return this.request(`/me/fulfillment-queue?filter=${encodeURIComponent(filter)}`);
  }

  async resolvePackingStation(reference: string): Promise<PackingStationResolveView> {
    return this.request("/me/packing-station/resolve", {
      method: "POST",
      body: { reference },
    });
  }

  async createTransaction(input: TransactionWriteInput = {}): Promise<TransactionView> {
    return this.request("/transactions", {
      method: "POST",
      body: {
        externalReference: input.externalReference ?? null,
        transactionDate: input.transactionDate ?? null,
        itemTitle: input.itemTitle ?? null,
        itemDescription: input.itemDescription ?? null,
        quantity: input.quantity ?? null,
        transactionValue: input.transactionValue ?? null,
        currency: input.currency ?? null,
        metadata: input.metadata ?? {},
        shipping: input.shipping ?? null,
      },
    });
  }

  async importTransaction(input: {
    adapterKey?: string;
    externalTransactionId?: string | null;
    createProof?: boolean;
  } = {}): Promise<TransactionImportView> {
    return this.request("/integrations/transactions/import", {
      method: "POST",
      body: {
        adapterKey: input.adapterKey ?? "demo-marketplace",
        mode: "reference",
        externalTransactionId: input.externalTransactionId ?? null,
        createProof: input.createProof === true,
      },
    });
  }

  async importShipmentEvents(input: {
    adapterKey?: string;
    transactionId?: string | null;
    externalTransactionId?: string | null;
    throughEventType?: string | null;
  }): Promise<ShipmentImportView> {
    return this.request("/integrations/shipment-events/import", {
      method: "POST",
      body: {
        adapterKey: input.adapterKey ?? "demo-carrier",
        mode: "reference",
        transactionId: input.transactionId ?? null,
        externalTransactionId: input.externalTransactionId ?? null,
        throughEventType: input.throughEventType ?? null,
      },
    });
  }

  async syncShipment(transactionId: string): Promise<ShipmentSyncView> {
    return this.request(`/transactions/${encodeURIComponent(transactionId)}/shipment-sync`, {
      method: "POST",
      body: {},
    });
  }

  async connectTrustedDemo(transactionId: string): Promise<unknown> {
    return this.request("/dev/integrations/trusted-demo/connect", {
      method: "POST",
      body: { transactionId },
    });
  }

  async getTransaction(transactionId: string): Promise<TransactionView> {
    return this.request(`/transactions/${encodeURIComponent(transactionId)}`);
  }

  async updateTransaction(
    transactionId: string,
    input: TransactionWriteInput,
  ): Promise<TransactionView> {
    return this.request(`/transactions/${encodeURIComponent(transactionId)}`, {
      method: "PATCH",
      body: {
        externalReference: input.externalReference,
        transactionDate: input.transactionDate,
        itemTitle: input.itemTitle,
        itemDescription: input.itemDescription,
        quantity: input.quantity,
        transactionValue: input.transactionValue,
        currency: input.currency,
      },
    });
  }

  async updateShipping(
    transactionId: string,
    input: ShippingWriteInput,
  ): Promise<TransactionView> {
    return this.request(`/transactions/${encodeURIComponent(transactionId)}/shipping`, {
      method: "PATCH",
      body: {
        carrier: input.carrier,
        service: input.service,
        trackingNumber: input.trackingNumber,
        shipmentDate: input.shipmentDate,
      },
    });
  }

  async createOrGetProof(transactionId: string): Promise<ProofView> {
    return this.request(`/transactions/${encodeURIComponent(transactionId)}/proof`, {
      method: "POST",
    });
  }

  async getProof(proofId: string): Promise<ProofView> {
    return this.request(`/proofs/${encodeURIComponent(proofId)}`);
  }

  async getShipmentIntegrity(proofId: string): Promise<ShipmentIntegrityView> {
    return this.request(`/proofs/${encodeURIComponent(proofId)}/shipment-integrity`);
  }

  async createInvitation(
    proofId: string,
    inviteeIdentifier: string | { inviteeIdentifier?: string; inviteeUserId?: string },
  ): Promise<{ invitation: InvitationView; proof: ProofView }> {
    const body =
      typeof inviteeIdentifier === "string"
        ? { inviteeIdentifier }
        : inviteeIdentifier;
    return this.request(`/proofs/${encodeURIComponent(proofId)}/invitations`, {
      method: "POST",
      body,
    });
  }

  async acceptInvitation(
    token: string,
  ): Promise<{ invitation: InvitationView; proof: ProofView }> {
    return this.request(`/invitations/${encodeURIComponent(token)}/accept`, {
      method: "POST",
    });
  }

  async createAttestation(
    proofId: string,
    input: { statement: string; relatedEvidenceId?: string },
  ): Promise<{ attestation: unknown; proof: ProofView }> {
    return this.request(`/proofs/${encodeURIComponent(proofId)}/attestations`, {
      method: "POST",
      body: input,
    });
  }

  async initializeEvidenceUpload(
    proofId: string,
    input: {
      contentType: string;
      evidenceType?: string;
      idempotencyKey: string;
    },
  ): Promise<EvidenceUploadView> {
    return this.request(`/proofs/${encodeURIComponent(proofId)}/evidence/uploads`, {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: {
        contentType: input.contentType,
        evidenceType: input.evidenceType ?? "SELLER_EVIDENCE",
      },
    });
  }

  async uploadObject(
    target: UploadTarget,
    body: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const url = resolveUploadUrl(this.options.baseUrl, target.url);
    const headers: Record<string, string> = {
      ...target.headers,
      "Content-Type": contentType,
    };
    const response = await fetch(url, {
      method: target.method,
      headers,
      body: toFetchBody(body),
    });
    if (!response.ok) {
      throw await errorFromResponse(response);
    }
  }

  async commitEvidence(
    proofId: string,
    evidenceId: string,
    sha256?: string,
  ): Promise<{ proof: ProofView; sha256: string; evidenceId: string }> {
    return this.request(
      `/proofs/${encodeURIComponent(proofId)}/evidence/${encodeURIComponent(evidenceId)}/commit`,
      {
        method: "POST",
        body: sha256 ? { sha256 } : {},
      },
    );
  }

  async submitEvidence(input: {
    proofId: string;
    bytes: Uint8Array;
    contentType: string;
    idempotencyKey: string;
  }): Promise<ProofView> {
    const initialized = await this.initializeEvidenceUpload(input.proofId, {
      contentType: input.contentType,
      idempotencyKey: input.idempotencyKey,
    });
    await this.uploadObject(initialized.upload, input.bytes, input.contentType);
    const committed = await this.commitEvidence(input.proofId, initialized.evidenceId);
    return this.getProof(committed.proof.proofId);
  }

  async finalizeProof(
    proofId: string,
  ): Promise<{ proof: ProofView; manifest: ManifestView }> {
    return this.request(`/proofs/${encodeURIComponent(proofId)}/finalize`, {
      method: "POST",
    });
  }

  async getManifest(proofId: string): Promise<ManifestView> {
    return this.request(`/proofs/${encodeURIComponent(proofId)}/manifest`);
  }

  private async request<T>(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      auth?: boolean;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(init.headers ?? {}),
    };
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (init.auth !== false) {
      const token = this.options.getToken();
      if (!token) {
        throw new ApiError("UNAUTHENTICATED", "Missing bearer token", 401);
      }
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(joinUrl(this.options.baseUrl, path), {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const relative = path.startsWith("/") ? path.slice(1) : path;
  return new URL(relative, base).toString();
}

export function resolveUploadUrl(baseUrl: string, targetUrl: string): string {
  const target = new URL(targetUrl, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (target.pathname.startsWith("/upload/")) {
    return joinUrl(baseUrl, `${target.pathname}${target.search}`);
  }
  return target.toString();
}

function toFetchBody(body: Uint8Array): Uint8Array {
  return body;
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  let code = "HTTP_ERROR";
  let message = `HTTP ${response.status}`;
  try {
    const payload = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    code = payload.error?.code ?? code;
    message = payload.error?.message ?? message;
  } catch {
    // Keep the HTTP fallback when the body is not JSON.
  }
  return new ApiError(code, message, response.status);
}
