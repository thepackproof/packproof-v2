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
  workflowType?: string;
  workflowStage?: string;
  nextAction?: {
    type: string;
    title: string;
    hint: string;
    assetId?: string;
    captureRecipe?: string;
    transferId?: string;
    actorRole?: string;
  } | null;
  assets?: Array<{
    assetId: string;
    assetInstanceId: string;
    assetType: string;
    label: string;
    labelIndex: number;
    catalogDescriptor?: Record<string, unknown>;
  }>;
  observations?: Array<{
    observationId: string;
    type: string;
    label: string;
    occurredAt: string;
    assetIds: string[];
    evidence: Array<{ evidenceId: string; slot: string }>;
  }>;
  transfers?: Array<{
    transferId: string;
    status: string;
    transferType: string;
    intervalNote: string | null;
    toObservationId: string | null;
  }>;
  continuityObservations?: Array<{
    evaluationId: string;
    result: string;
    summary: string;
    algorithmVersion: string;
    evidencePairs: Array<{
      slot: string;
      originEvidenceId: string | null;
      receivedEvidenceId: string | null;
    }>;
  }>;
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
    service?: string | null;
    transactionValue?: number | null;
    currency?: string | null;
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

export type FulfillmentWorkflowState =
  | "READY_TO_PACK"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "REMOVED_FROM_FULFILLMENT";

export interface FulfillmentQueueItem {
  transactionId: string;
  proofId: string;
  connectionId: string;
  provider: string;
  providerDisplay: string;
  externalAccountReference: string | null;
  externalOrderId: string;
  externalReference: string | null;
  items: TransactionItemView[];
  itemSummary: string;
  itemCount: number;
  transactionValue: number | null;
  currency: string | null;
  orderedAt: string | null;
  proofStatus: string;
  participationPolicy: string;
  sellerPackingAttested: boolean;
  evidenceCount: number;
  pendingEvidenceCount: number;
  fulfillmentCaptureCount?: number;
  canComplete: boolean;
  workflowState: FulfillmentWorkflowState | string;
}

export interface CommerceConnectionView {
  connectionId: string;
  adapterKey: string;
  provider: string;
  providerDisplay: string;
  externalAccountReference: string | null;
  status: string;
  lastSyncAt: string | null;
  lastErrorCode: string | null;
  retryable: boolean | null;
  readyOrderCount: number;
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

export interface CommerceSyncView {
  connectionId: string;
  adapterKey: string;
  provider: string;
  discoveredCount: number;
  eligibleCount: number;
  createdTransactionCount: number;
  createdProofCount: number;
  existingProofCount: number;
  ineligibleCount: number;
  cursor: string | null;
}

export interface EbayMarketplaceView {
  provider: "ebay";
  adapterKey: string;
  enabled: boolean;
  environment: string;
  connection: {
    connectionId: string;
    status: string;
    displayName: string | null;
    connectedAt: string;
    updatedAt: string;
  } | null;
}

export interface EbaySellerOrderView {
  externalOrderId: string;
  title: string;
  soldAt: string | null;
  total: number | null;
  currency: string | null;
  fulfillmentStatus: string;
  fulfillmentLabel: string;
  buyerUsername: string | null;
  quantity: number | null;
  proofId: string | null;
  transactionId: string | null;
}

export interface EbayOrderListView {
  role: string;
  connection: {
    connectionId: string;
    status: string;
    displayName: string | null;
  };
  orders: EbaySellerOrderView[];
  disclosure: string;
}

export interface PublicProofView {
  schema?: "packproof.proof.public/v1" | string;
  proofId: string;
  status: string;
  workflowType: string;
  workflowStage: string;
  nextAction: { type: string; title: string; hint: string } | null;
  scope: string;
  join: {
    eligible: boolean;
    requiresAuthentication: boolean;
    message: string;
  };
  assets?: Array<{ label: string; assetType: string }>;
  observations?: Array<{ label: string; occurredAt: string }>;
  transfers?: Array<{ status: string; intervalNote: string | null }>;
  continuity?: Array<{ result: string; summary: string }>;
}

export interface AccessLinkView {
  accessLinkId: string;
  proofId: string;
  scope: string;
  url?: string;
  token?: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ProviderCapabilities {
  identity: boolean;
  transactions: boolean;
  fulfillment: boolean;
  shipping: boolean;
  webhooks: boolean;
}

export interface ConnectedAccountView {
  id: string;
  provider: string;
  providerDisplay: string;
  externalAccountId: string;
  externalAccountName: string | null;
  status: string;
  scopes: string[];
  expiresAt: string | null;
  capabilities: ProviderCapabilities;
  limitations: string[];
  createdAt: string;
  updatedAt: string;
  disconnectedAt: string | null;
}

export interface ConnectedAccountProviderCatalogView {
  provider: string;
  providerDisplay: string;
  enabled: boolean;
  capabilities: ProviderCapabilities;
  limitations: string[];
  multipleAccounts: boolean;
  requiresShop: boolean;
}

export interface ConnectedAccountsListView {
  accounts: ConnectedAccountView[];
  providers: ConnectedAccountProviderCatalogView[];
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
