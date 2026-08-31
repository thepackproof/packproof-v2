export interface ImportedShipmentEvent {
  eventType: string;
  occurredAt: string;
  carrier?: string | null;
  locationText?: string | null;
  source: string;
  provider: string;
  sourceEventId?: string | null;
  eventData?: Record<string, unknown> | null;
  payloadSha256?: string | null;
}
