import { DomainError } from "./errors.js";

export const PARTICIPATION_POLICIES = [
  "COUNTERPARTY_REQUIRED",
  "COUNTERPARTY_OPTIONAL",
] as const;

export type ParticipationPolicy = (typeof PARTICIPATION_POLICIES)[number];

/**
 * Ordinary seller-created Proofs do not require a buyer before evidence
 * capture or finalization. COUNTERPARTY_REQUIRED remains available when an
 * integration or API request sets it explicitly. Existing stored Proofs keep
 * the policy written at creation (immutable).
 *
 * Viewer vs participant (conceptual; viewers are not implemented here):
 * - A participant explicitly joins and may contribute authorized actions.
 * - A viewer would be read-only, imply no attestation, and must not be
 *   created by treating "opened the Proof" as membership.
 */
export const DEFAULT_PARTICIPATION_POLICY: ParticipationPolicy = "COUNTERPARTY_OPTIONAL";

export function isParticipationPolicy(value: unknown): value is ParticipationPolicy {
  return typeof value === "string" && (PARTICIPATION_POLICIES as readonly string[]).includes(value);
}

export function requireParticipationPolicy(
  value: unknown,
  fallback: ParticipationPolicy = DEFAULT_PARTICIPATION_POLICY,
): ParticipationPolicy {
  if (value == null || value === "") {
    return fallback;
  }
  if (!isParticipationPolicy(value)) {
    throw new DomainError(
      "INVALID_PARTICIPATION_POLICY",
      "participationPolicy must be COUNTERPARTY_REQUIRED or COUNTERPARTY_OPTIONAL",
      400,
    );
  }
  return value;
}
