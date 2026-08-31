export type ProofStatus =
  | "OPEN"
  | "AWAITING_PARTICIPANT"
  | "READY_FOR_EVIDENCE"
  | "EVIDENCE_COMMITTED"
  | "FINALIZED";

export type TrustKind = "FACT" | "ATTESTATION" | "EXTERNAL";

export type ChronologyCategory = "PROOF" | "COMMERCE" | "SHIPMENT";

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
  category: ChronologyCategory | string;
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
