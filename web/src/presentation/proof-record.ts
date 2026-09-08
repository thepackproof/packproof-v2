import type { CanonicalProof, ChronologyEntry } from "../api/types";

export type AuditEntry = NonNullable<CanonicalProof["events"]>[number];
export type ActivityGroup = { id: string; entries: ChronologyEntry[]; access: boolean };
export const ACCESS_WINDOW_MS = 30 * 60 * 1000;

export function isAccessEvent(entry: ChronologyEntry): boolean {
  return /(?:ACCESSED|VIEWED|DOWNLOADED)$/.test(entry.eventType) || ["DISCLOSURE_SCOPE_REVIEWED", "PROOF_VIEWED_VIA_ACCESS_LINK", "CASE_PACKET_PREVIEWED"].includes(entry.eventType);
}

export function sortedRecordEvents(entries: ChronologyEntry[]): ChronologyEntry[] {
  return [...entries].sort((a, b) => {
    const first = Date.parse(a.occurredAt), second = Date.parse(b.occurredAt);
    const difference = (Number.isFinite(first) ? first : Infinity) - (Number.isFinite(second) ? second : Infinity);
    return (Number.isNaN(difference) ? 0 : difference) || a.id.localeCompare(b.id);
  });
}

/** Presentation only: same known actor, same link and same fixed 30-minute UTC window.
 * Unknown actors without a known link remain separate. This never counts unique people.
 * Every group retains the original event objects and their identifiers.
 */
export function groupRecordActivity(entries: ChronologyEntry[], audit: AuditEntry[] = []): ActivityGroup[] {
  const raw = new Map(audit.map(event => [event.eventId, event]));
  const groups: ActivityGroup[] = [];
  const accessGroups = new Map<string, ActivityGroup>();
  for (const entry of sortedRecordEvents(entries)) {
    const access = isAccessEvent(entry);
    const event = raw.get(entry.id);
    const linkValue = event?.data.accessLinkId ?? event?.data.linkId;
    const link = typeof linkValue === "string" && linkValue.trim() ? linkValue : null;
    const actor = event?.actorUserId;
    const time = Date.parse(entry.occurredAt);
    const key = access && (actor || link) && Number.isFinite(time)
      ? JSON.stringify([actor || null, link, entry.source, Math.floor(time / ACCESS_WINDOW_MS)])
      : null;
    const existing = key ? accessGroups.get(key) : undefined;
    if (existing) existing.entries.push(entry);
    else {
      const group = { id: entry.id, entries: [entry], access };
      groups.push(group);
      if (key) accessGroups.set(key, group);
    }
  }
  return groups;
}

export function activityTitle(entry: ChronologyEntry): string {
  const labels: Record<string, string> = {
    TRANSACTION_IMPORTED: "Order connected",
    EVIDENCE_COMMITTED: "Recording saved",
    ATTESTATION_COMMITTED: "Declaration confirmed",
    SELLER_PACKING_ATTESTED: "Declaration confirmed",
    PROOF_FINALIZED: "Proof locked",
    ACCESS_LINK_CREATED: "Share link created",
  };
  return labels[entry.eventType] || entry.title;
}

export type TrackingAvailability = {
  registration?: { state: string; errorCode: string | null; mode?: string | null } | null;
  sync?: { available: boolean; status: string | null; lastSuccessfulSyncAt?: string | null } | null;
  refreshError?: string | null;
};

export function trackingAvailabilityMessage(trackingNumber: string | null | undefined, context: TrackingAvailability = {}): string | null {
  if (!trackingNumber?.trim()) return "No tracking number is attached to this Proof. Your recording remains available.";
  const error = context.registration?.errorCode || "";
  const state = context.registration?.state || "";
  const status = context.sync?.status || "";
  if (/UNSUPPORTED/.test(error) || status === "UNSUPPORTED") return "Automatic tracking isn’t supported for this shipment. The tracking number and recording remain available.";
  if (error === "SHIPPO_TEST_TRACKING_ONLY" || (context.registration?.mode === "test" && state !== "REGISTERED")) return "Live carrier tracking isn’t available for this shipment. The tracking number and recording remain available.";
  if (context.refreshError || state === "FAILED" || ["ERROR", "FAILED", "NEEDS_REAUTH", "DISCONNECTED"].includes(status)) return "Carrier updates are temporarily unavailable. Your tracking number and previously recorded reports remain available. Try refreshing later.";
  if (error === "SHIPMENT_CARRIER_REQUIRED") return "Tracking number recorded. A carrier must be identified before automatic updates can begin.";
  if (state === "WAITING_FOR_CONNECTION" || context.sync?.available === false) return "Carrier updates aren’t connected for this shipment. Your tracking number and recording remain available.";
  if (["PENDING", "REGISTERING", "QUEUED"].includes(state) || ["PENDING", "RUNNING", "RETRYING", "DELAYED"].includes(status)) return "Tracking updates are still being checked. Your recording remains available.";
  return null;
}
