import {
  ApiError,
  type CanonicalProof,
  type InvitationInboxView,
  type InvitationView,
  type ManifestView,
  type ProfileView,
  type ProofCollectionItem,
  type PublicProfileView,
  type TransactionImportView,
  type TransactionView,
  type TransactionWriteInput,
  type ShipmentImportView,
  type ShipmentIntegrityView,
  type ShipmentSyncView,
  type CommerceConnectionView,
  type CommerceSyncView,
  type FulfillmentQueueItem,
  type PackingStationResolveView,
  type EvidenceUploadView,
  type UploadTarget,
  type EbayMarketplaceView,
  type EbayOrderListView,
} from "./types";

export class PackProofApi {
  constructor(
    private readonly options: {
      baseUrl: string;
      getToken: () => string | null;
    },
  ) {}

  async loginDev(subject: string): Promise<{ userId: string; token: string }> {
    return this.request("/auth/dev/login", {
      method: "POST",
      auth: false,
      body: { subject },
    });
  }

  async getMe(): Promise<ProfileView> {
    return this.request("/me");
  }

  async updateProfile(input: { username?: string; displayName?: string }): Promise<ProfileView> {
    const body: { username?: string; displayName?: string } = {};
    if (input.username !== undefined) {
      body.username = input.username;
    }
    if (input.displayName !== undefined) {
      body.displayName = input.displayName;
    }
    return this.request("/me/profile", {
      method: "PATCH",
      body,
    });
  }

  async listMyProofs(): Promise<{ proofs: ProofCollectionItem[] }> {
    return this.request("/me/proofs");
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

  async listCommerceConnections(): Promise<{ connections: CommerceConnectionView[] }> {
    return this.request("/me/integration-connections?capability=commerce");
  }

  async listMarketplaces(): Promise<{ marketplaces: EbayMarketplaceView[] }> {
    return this.request("/me/marketplaces");
  }

  async startEbayConnect(): Promise<{ authorizationUrl: string; expiresAt: string }> {
    return this.request("/me/marketplaces/ebay/connect", { method: "POST" });
  }

  async disconnectEbay(): Promise<void> {
    await this.request("/me/marketplaces/ebay/disconnect", { method: "POST" });
  }

  async listEbaySellerOrders(): Promise<EbayOrderListView> {
    return this.request("/me/marketplaces/ebay/orders");
  }

  async importEbaySellerOrder(
    orderId: string,
    input: { createProof?: boolean } = {},
  ): Promise<TransactionImportView> {
    return this.request(
      `/me/marketplaces/ebay/orders/${encodeURIComponent(orderId)}/import`,
      {
        method: "POST",
        body: { createProof: input.createProof === true },
      },
    );
  }

  async syncCommerceConnection(connectionId: string): Promise<CommerceSyncView> {
    return this.request(`/me/commerce-connections/${encodeURIComponent(connectionId)}/sync`, {
      method: "POST",
      body: {},
    });
  }

  async connectDemoStorefront(
    externalAccountReference?: string,
  ): Promise<{ connection: CommerceConnectionView }> {
    return this.request("/dev/integrations/demo-storefront/connect", {
      method: "POST",
      body: externalAccountReference ? { externalAccountReference } : {},
    });
  }

  async listInvitations(): Promise<{ invitations: InvitationInboxView[] }> {
    return this.request("/invitations");
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

  async getProof(proofId: string): Promise<CanonicalProof> {
    return this.request(`/proofs/${encodeURIComponent(proofId)}`);
  }

  async getShipmentIntegrity(proofId: string): Promise<ShipmentIntegrityView> {
    return this.request(`/proofs/${encodeURIComponent(proofId)}/shipment-integrity`);
  }

  async createTransaction(input: TransactionWriteInput = {}): Promise<TransactionView> {
    return this.request("/transactions", {
      method: "POST",
      body: input,
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

  async createOrGetProof(transactionId: string): Promise<CanonicalProof> {
    return this.request(`/transactions/${encodeURIComponent(transactionId)}/proof`, {
      method: "POST",
    });
  }

  async createInvitation(
    proofId: string,
    input: { inviteeIdentifier?: string; inviteeUserId?: string },
  ): Promise<{ invitation: InvitationView; proof: CanonicalProof }> {
    const result = await this.request<{ invitation: InvitationView; proof: CanonicalProof }>(
      `/proofs/${encodeURIComponent(proofId)}/invitations`,
      {
        method: "POST",
        body: input,
      },
    );
    return { invitation: publicInvitation(result.invitation), proof: result.proof };
  }

  async acceptInvitation(
    tokenOrId: string,
  ): Promise<{ invitation: InvitationView; proof: CanonicalProof }> {
    const result = await this.request<{ invitation: InvitationView; proof: CanonicalProof }>(
      `/invitations/${encodeURIComponent(tokenOrId)}/accept`,
      {
        method: "POST",
      },
    );
    return { invitation: publicInvitation(result.invitation), proof: result.proof };
  }

  async initializeEvidenceUpload(
    proofId: string,
    input: { contentType: string; evidenceType?: string; idempotencyKey: string },
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
    body: Blob,
    contentType: string,
  ): Promise<void> {
    const url = resolveUploadUrl(this.options.baseUrl, target.url);
    const response = await fetch(url, {
      method: target.method,
      headers: {
        ...target.headers,
        "Content-Type": contentType,
      },
      body,
    });
    if (!response.ok) {
      throw await errorFromResponse(response);
    }
  }

  async commitEvidence(
    proofId: string,
    evidenceId: string,
  ): Promise<{ proof: CanonicalProof; sha256: string; evidenceId: string }> {
    return this.request(
      `/proofs/${encodeURIComponent(proofId)}/evidence/${encodeURIComponent(evidenceId)}/commit`,
      { method: "POST", body: {} },
    );
  }

  async createAttestation(
    proofId: string,
    input: { statement: string; relatedEvidenceId?: string },
  ): Promise<{ attestation: unknown; proof: CanonicalProof }> {
    return this.request(`/proofs/${encodeURIComponent(proofId)}/attestations`, {
      method: "POST",
      body: input,
    });
  }

  async finalizeProof(proofId: string): Promise<{ proof: CanonicalProof; manifest: ManifestView }> {
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
      auth?: boolean;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", ...(init.headers ?? {}) };
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
    const text = await response.text();
    if (!text.trim()) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }
}

function publicInvitation(invitation: InvitationView & { token?: string }): InvitationView {
  return {
    invitationId: invitation.invitationId,
    proofId: invitation.proofId,
    inviteeIdentifier: invitation.inviteeIdentifier,
    inviteeUserId: invitation.inviteeUserId ?? null,
    status: invitation.status,
    createdAt: invitation.createdAt,
    acceptedAt: invitation.acceptedAt,
    expiresAt: invitation.expiresAt,
  };
}

export function resolveUploadUrl(baseUrl: string, targetUrl: string): string {
  if (!baseUrl) {
    return targetUrl;
  }
  const target = new URL(targetUrl, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (target.pathname.startsWith("/upload/")) {
    return joinUrl(baseUrl, `${target.pathname}${target.search}`);
  }
  return target.toString();
}

export function joinUrl(baseUrl: string, path: string): string {
  if (!baseUrl) {
    return path.startsWith("/") ? path : `/${path}`;
  }
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const relative = path.startsWith("/") ? path.slice(1) : path;
  return new URL(relative, base).toString();
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  let code = "HTTP_ERROR";
  let message = `HTTP ${response.status}`;
  try {
    const payload = (await response.json()) as { error?: { code?: string; message?: string } };
    code = payload.error?.code ?? code;
    message = payload.error?.message ?? message;
  } catch {
    // Keep the HTTP fallback.
  }
  return new ApiError(code, message, response.status);
}
