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

export interface TransactionView {
  transactionId: string;
  externalReference: string | null;
  transactionDate: string | null;
  itemTitle: string | null;
  itemDescription: string | null;
  quantity: number | null;
  transactionValue: number | null;
  currency: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  metadata: unknown;
  shipping: ShippingView | null;
  proofId: string | null;
  proofStatus: string | null;
  sellerUserId: string;
  buyerUserId: string | null;
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

export interface ProofView {
  proofId: string;
  transactionId: string;
  status: ProofStatus | string;
  version: number;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  manifestId: string | null;
  transaction: TransactionView;
  participants: Array<{
    participantId: string;
    userId: string;
    role: string;
    status: "JOINED" | string;
    joinedAt: string;
  }>;
  evidence: Array<{
    evidenceId: string;
    evidenceType: string;
    validationStatus: string;
    sha256: string | null;
    byteSize: number | null;
    committedAt: string | null;
  }>;
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

export interface PublicProfileView {
  userId: string;
  username: string;
  displayName: string | null;
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

  async listInvitations(): Promise<{ invitations: InvitationInboxView[] }> {
    return this.request("/invitations");
  }

  async listMyProofs(): Promise<{ proofs: ProofCollectionItem[] }> {
    return this.request("/me/proofs");
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
