export interface CaseReference { id?: string; type: string; namespace: string; externalId: string; parentExternalId?: string }
export interface OperationalCaseSummary {
  id: string; reference: string; type?: string; locationId: string | null; state: 'provisional' | 'reconstructed';
  updatedAt: string; shipmentCount: number; issueCount: number | null;
  proofIds?: string[]; restrictedMembers?: boolean;
}
export interface OperationalCaseList {
  resourceType: 'operational_case'; cases: OperationalCaseSummary[]; total: number;
  nextCursor: string | null; hasMore: boolean;
}
export interface CaseAssertion {
  id: string; subject: CaseReference; property: string; value: unknown; unit?: string | null; active: boolean;
  source: { connectionId: string; receiptId: string; row: number; field: string; mappingVersion: string;
    revision: string; reportedAt: string | null; sourceAsOf: string | null; receivedAt: string;
    timeQuality: string; originalSha256: string; origin?: string | null };
}
export interface CaseComparison {
  id: string; subject: CaseReference; ruleVersion: string;
  outcome: 'different' | 'within_tolerance' | 'not_comparable' | 'suppressed';
  title: string; explanation: string; inputAssertionIds: string[];
  absoluteDifference: { numerator: string; denominator: string } | null; baseUnit: string | null; physicalCondition: 'not_established';
  inputs?: Array<{ id: string; property: string; value: unknown; source: { connectionId: string; receiptId: string; row: number; field: string; revision: string; reportedAt: string | null; sourceAsOf: string | null; receivedAt: string } }>;
}
export interface CaseRelationship {
  id: string; from: CaseReference; to: CaseReference; type: string; quantity: unknown;
  sourceReceiptId: string; row: number; restricted: boolean; active?: boolean;
}
export interface CaseTimelineEntry {
  id: string; observationKind: string; reportedAt: string | null; sourceAsOf: string | null;
  receivedAt: string; timeQuality: string; late: boolean; sourceConnectionId: string; assertionIds: string[]; active?: boolean;
}
export interface CaseSourceHealth {
  subscriptionId?: string | null;
  connectionId: string; sourceNamespace: string; state: string; label: string; displayName?: string;
  lastReceivedAt: string | null; sourceAsOf: string | null; lastCheckedAt: string | null;
  expectedIntervalSeconds: number | null; coverage: 'qualified' | 'unknown'; nextAction: string;
  accounting: { received: number; acceptedLinked: number; acceptedUnlinked: number; duplicate: number;
    conflict: number; quarantined: number; rejected: number; processing: number; reconciled: boolean };
}
export type CaseSection = 'comparisons' | 'assertions' | 'relationships' | 'timeline';
export interface OperationalCaseDetail {
  schema: string; projectionVersion: string; case: OperationalCaseSummary;
  assertions: CaseAssertion[]; comparisons: CaseComparison[]; relationships: CaseRelationship[];
  timeline: CaseTimelineEntry[]; sources: CaseSourceHealth[]; limitations: string[];
  sourceHealthStatus?: { available: boolean; reason: string | null };
  rulesStatus?: { available: boolean; reason: string | null };
  pagination: { section: CaseSection; limit: number; total: number; returnedCount: number;
    hasMore: boolean; nextCursor: string | null; projectionVersion: string };
}
export interface CaseSourceExtract {
  assertionId: string; original: { name: string; sha256: string };
  locator: { row: number; field: string }; value: unknown;
  source: { connectionId: string; mappingVersion: string; revision: string };
  extraction: 'case_scoped';
  originalAvailable: boolean;
}
