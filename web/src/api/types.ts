export type ProofStatus =
  | "OPEN"
  | "AWAITING_PARTICIPANT"
  | "READY_FOR_EVIDENCE"
  | "EVIDENCE_COMMITTED"
  | "FINALIZED";

export type TrustKind = "FACT" | "ATTESTATION" | "EXTERNAL";

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
  shipping?: {
    carrier?: string | null;
    service?: string | null;
    trackingNumber?: string | null;
    shipmentDate?: string | null;
  } | null;
}

export interface CanonicalProof {
  schema?: "packproof.proof.canonical/v1" | string;
  proofId: string;
  transactionId: string;
  status: ProofStatus | string;
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
    participantId?: string;
    statement: string;
    relatedEvidenceId: string | null;
    relatedEventId?: string | null;
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

export interface InvitationView {
  invitationId: string;
  proofId: string;
  inviteeIdentifier: string;
  inviteeUserId?: string | null;
  status: string;
  createdAt: string;
  acceptedAt: string | null;
  expiresAt: string | null;
}

export interface ManifestView {
  manifestId: string;
  proofId: string;
  sha256: string;
  canonicalJson: string;
  manifest: unknown;
}

export interface TransactionImportView {
  transaction: TransactionView;
  proof: CanonicalProof | null;
  identity: {
    adapterKey: string;
    tenantKey: string;
    externalTransactionId: string;
    source: string;
  };
  created: boolean;
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
