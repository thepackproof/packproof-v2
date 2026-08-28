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
}

export interface ManifestRow {
  id: string;
  proof_id: string;
  canonical_json: string;
  sha256: string;
  created_at: Date | string;
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
