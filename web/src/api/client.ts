import {
  ApiError,
  type CanonicalProof,
  type InvitationInboxView,
  type InvitationView,
  type ManifestView,
  type ProfileView,
  type ProofCollectionItem,
  type PublicProfileView,
  type TransactionView,
  type TransactionWriteInput,
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

  async listMyProofs(): Promise<{ proofs: ProofCollectionItem[] }> {
    return this.request("/me/proofs");
  }

  async listInvitations(): Promise<{ invitations: InvitationInboxView[] }> {
    return this.request("/invitations");
  }

  async searchUsers(query: string): Promise<{ users: PublicProfileView[] }> {
    return this.request(`/users/search?q=${encodeURIComponent(query)}`);
  }

  async getProof(proofId: string): Promise<CanonicalProof> {
    return this.request(`/proofs/${encodeURIComponent(proofId)}`);
  }

  async createTransaction(input: TransactionWriteInput = {}): Promise<TransactionView> {
    return this.request("/transactions", {
      method: "POST",
      body: input,
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
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
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
    return (await response.json()) as T;
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
