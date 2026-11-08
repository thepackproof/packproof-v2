export type RecordEnvironment = 'live' | 'sandbox' | string;
export interface RecordOrganization { id: string; name: string; environment: RecordEnvironment; enabled: boolean; role: string; locations: Array<{ id: string; name: string }> }
export interface RecordsContext { schema: string; organizations: RecordOrganization[]; selectedOrganizationId: string | null; environment: RecordEnvironment; capabilities: { records: boolean; import: boolean; review: boolean; manage: boolean } }
export interface RecordSummary {
  id: string; proofId: string; organizationId: string; environment: string; reference: string | null; title: string | null;
  trackingNumber: string | null; carrier: string | null; createdAt: string; updatedAt: string; revision: number;
  lifecycle: 'open' | 'closed'; sample: boolean; locationId: string | null;
  source?: { id?: string; name?: string; kind?: string }; sourceName?: string; stage?: string;
  coverage: { satisfied: number; total: number; waived: number; missing: number; notYetDue: number };
  integrity: 'not_sealed' | 'sealed' | string; review: 'needs_attention' | 'reviewed' | 'unreviewed'; issueCount: number;
}
export interface RecordsList { records: RecordSummary[]; nextCursor: string | null; counts: { total: number; open: number; needsAttention: number; closed: number; policyComplete?: number }; updatedAt: string }
export interface RecordIssue { assignment?:{membershipId:string|null;userId:string|null;membershipActive:boolean;assignedBy:string;assignedAt:string;reason:string}|null; id: string; proofId?: string; recordId?: string; revision?: number; category?: string; type?: string; severity?: string; state?: string; status?: string; title?: string; description?: string; subjectId?: string; entityId?: string | null; assignedTo?: string | null; createdAt?: string; updatedAt?: string; reason?: string | null; actions?: Array<{ id: string; action: string; reason: string; actorId: string; createdAt: string }>; [key: string]: unknown }
export interface RecordTimelineEntry { id: string; type?: string; eventType?: string; title?: string; summary?: string; description?: string; reportedAt?: string | null; occurredAt?: string | null; receivedAt?: string | null; createdAt?: string; source?: string | { name?: string; kind?: string }; subjectId?: string; entityId?: string | null; sequence?: number; data?: Record<string, unknown>; [key: string]: unknown }
export interface RecordEvidence { id?: string; evidenceId?: string; name?: string; filename?: string; originalFileName?: string; contentType?: string; mimeType?: string; evidenceType?: string; type?: string; status?: string; state?: string; validationStatus?: string; processingState?: string; source?: string | { name?: string }; receivedAt?: string; createdAt?: string; sha256?: string | null; byteSize?: number | null; sizeBytes?: number; entityId?: string | null; subjectIds?: string[]; original?: boolean; [key: string]: unknown }
export interface RecordRequirement { id?: string; requirementId?: string; title?: string; label?: string; status?: string; state?: string; entityId?: string | null; subjectId?: string; stage?: string; templateVersion?: string; dueAt?: string | null; evidenceIds?: string[]; waiver?: { reason: string } | null; description?: string; [key: string]: unknown }
export interface RecordRelationship { id: string; type?: string; label?: string; reference?: string; [key: string]: unknown }
export interface RecordDetail { record: RecordSummary; timeline: RecordTimelineEntry[]; evidence: RecordEvidence[]; requirements: RecordRequirement[]; issues: RecordIssue[]; relationships: RecordRelationship[]; evidenceNextCursor?: string | null; timelineNextCursor?: string | null; assurance?: { coreManifest: 'present' | 'absent'; operationalView: 'not_a_signed_snapshot'; physicalCondition: 'not_established'; explanation: string }; sourceHealth: { state: string; [key: string]: unknown }; capabilities: { [key: string]: boolean } }
export interface RecordConnection { id?: string; connectionId?: string; name?: string; provider?: string; accountName?: string; state?: string; status?: string; health?: string | { state?: string }; environment?: string; locationIds?: string[]; lastSuccessfulContactAt?: string | null; lastUsableEventAt?: string | null; lastReconciliationAt?: string | null; oldestQueuedAt?: string | null; owner?: string | null; availableData?: string[]; reason?: string; [key: string]: unknown }
export interface SourceAssociation {
  id: string; connectionId: string; locationId: string | null; sourceEventId: string;
  reference: { type: 'SHIPMENT' | 'ORDER' | 'RETURN' | 'package' | 'pallet' | 'item'; externalId: string };
  sourceKind: string; sourceSchemaVersion: string; mappingVersion: string;
  state: 'pending' | 'submitted' | 'conflict' | 'blocked_policy' | 'retryable_error';
  operationId: string | null; proofId: string | null; attempts: number; errorCode: string | null;
  resolution: { outcome?: string; proofId?: string | null; candidates?: string[]; ruleVersion?: string; basis?: string };
  reportedAt?: string | null; receivedAt: string; updatedAt: string; sourceAssurance: 'organization_submitted';
}
export interface RecordExport { id?: string; exportId?: string; proofId?: string; recordId?: string; reference?: string; state?: string; status?: string; createdAt?: string; downloadAvailableUntil?: string | null; expiresAt?: string | null; downloadUrl?: string | null; omissions?: string[]; [key: string]: unknown }
