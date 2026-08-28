import { ulid } from "ulid";

export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export function newInvitationToken(): string {
  return ulid() + ulid();
}
