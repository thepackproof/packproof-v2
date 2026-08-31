import { DomainError } from "./errors.js";

export const PARTICIPATION_POLICIES = [
  "COUNTERPARTY_REQUIRED",
  "COUNTERPARTY_OPTIONAL",
] as const;

export type ParticipationPolicy = (typeof PARTICIPATION_POLICIES)[number];

export const DEFAULT_PARTICIPATION_POLICY: ParticipationPolicy = "COUNTERPARTY_REQUIRED";

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
