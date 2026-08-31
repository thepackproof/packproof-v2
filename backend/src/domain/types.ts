export type ProofStatus =
  | "OPEN"
  | "AWAITING_PARTICIPANT"
  | "READY_FOR_EVIDENCE"
  | "EVIDENCE_COMMITTED"
  | "FINALIZED";

export type ParticipantRole = "SELLER" | "BUYER";

export type InvitationStatus = "PENDING" | "ACCEPTED" | "EXPIRED" | "REVOKED";

export type EvidenceValidationStatus = "PENDING" | "COMMITTED" | "REJECTED";

export interface ProofRow {
  id: string;
  transaction_id: string;
  status: ProofStatus;
  created_at: Date | string;
  updated_at: Date | string;
  finalized_at: Date | string | null;
  manifest_id: string | null;
  version: number;
}

export interface ParticipantRow {
  id: string;
  proof_id: string;
  user_id: string;
  role: ParticipantRole;
  joined_at: Date | string;
}

export interface EvidenceRow {
  id: string;
  proof_id: string;
  submitted_by: string;
  object_key: string;
  content_type: string;
  byte_size: string | number | null;
  sha256: string | null;
  created_at: Date | string;
  committed_at: Date | string | null;
  validation_status: EvidenceValidationStatus;
  evidence_type: string;
  idempotency_key: string | null;
}

export interface InvitationRow {
  id: string;
  proof_id: string;
  inviter_user_id: string;
  invitee_identifier: string;
  invitee_user_id?: string | null;
  status: InvitationStatus;
  token: string;
  created_at: Date | string;
  accepted_at: Date | string | null;
  expires_at: Date | string | null;
}

export interface TransactionRow {
  id: string;
  external_reference: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  transaction_metadata: unknown;
  transaction_date: string | null;
  item_title: string | null;
  item_description: string | null;
  quantity: string | number | null;
  transaction_value: string | number | null;
  currency: string | null;
}

export interface ShippingRow {
  id: string;
  transaction_id: string;
  carrier: string | null;
  service: string | null;
  tracking_number: string | null;
  shipment_date: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ManifestRow {
  id: string;
  proof_id: string;
  canonical_json: string;
  sha256: string;
  created_at: Date | string;
}

export type AttestationStatement = "PACKED_DESCRIBED_ITEM" | "RECEIVED_PACKAGE";

export type ExternalReferenceSource = "PARTICIPANT_SUPPLIED" | "INTEGRATION";

export interface AttestationRow {
  id: string;
  proof_id: string;
  participant_id: string;
  attested_by: string;
  statement: AttestationStatement | string;
  related_evidence_id: string | null;
  related_event_id: string | null;
  sha256: string;
  created_at: Date | string;
}

export interface ProofExternalReferenceRow {
  id: string;
  proof_id: string;
  tenant_key: string;
  external_transaction_id: string;
  source: ExternalReferenceSource | string;
  supplied_by: string | null;
  provenance: unknown;
  created_at: Date | string;
}

export interface TransactionIntegrationIdentityRow {
  id: string;
  transaction_id: string;
  tenant_key: string;
  external_transaction_id: string;
  adapter_key: string;
  source: string;
  created_at: Date | string;
}

export interface AuditEventRow {
  id: string;
  proof_id: string;
  actor_user_id: string | null;
  event_type: string;
  event_version: number;
  event_data: unknown;
  created_at: Date | string;
}

export interface ShipmentEventRow {
  id: string;
  proof_id: string;
  transaction_id: string;
  shipping_id: string;
  event_type: string;
  occurred_at: Date | string;
  observed_at: Date | string;
  created_at: Date | string;
  carrier: string | null;
  location_text: string | null;
  source: string;
  provider: string;
  source_event_id: string | null;
  event_data: unknown;
  payload_sha256: string | null;
  content_sha256: string;
  previous_event_sha256: string | null;
  core_manifest_sha256: string | null;
  sha256: string;
  dedupe_fingerprint: string;
}

export function asIso(value: Date | string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}

export function asRequiredIso(value: Date | string): string {
  const iso = asIso(value);
  if (!iso) {
    throw new Error("expected timestamp");
  }
  return iso;
}
