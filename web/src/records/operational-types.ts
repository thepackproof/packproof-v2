export interface IdentityDerivation {
  schema: 'packproof.source-identity-derivation/v1';
  eventKey: { kind: 'column' | 'composite'; components: Array<{ field: string; value: string; sourceLocator: { row: number; field: string; jsonPointer?: string } | null; approvedConstant: boolean }> };
  revision: { kind: 'column' | 'source_as_of' | 'immutable_event'; sourceValue: string | null; sourceLocator: { row: number; field: string; jsonPointer?: string } | null };
}
export interface CaseReference { id?: string; type: string; namespace: string; externalId: string; parentExternalId?: string }
export interface OperationalCaseSummary {
  id: string; reference: string; type?: string; locationId: string | null; state: 'provisional' | 'reconstructed';
  updatedAt: string; shipmentCount: number; issueCount: number | null;
  proofIds?: string[]; proofCount?: number; restrictedMembers?: boolean;
}
export interface OperationalCaseList {
  resourceType: 'operational_case'; cases: OperationalCaseSummary[]; total: number;
  nextCursor: string | null; hasMore: boolean;
}
export interface ReferenceDecisionBasis { id: string; revisionHash: string; ruleVersion: string; reason: string; approvedBy: string; approvedAt: string; effectiveFrom: string | null; effectiveUntil: string | null }
export interface ComparisonIdentity { subject: CaseReference; fields: Array<{ reference: CaseReference; canonicalReference: CaseReference; basis: ReferenceDecisionBasis[] }> }
export interface CaseAssertion {
  id: string; subject: CaseReference; property: string; value: unknown; unit?: string | null; active: boolean;
  source: { connectionId: string; receiptId: string; row: number; field: string; mappingVersion: string;
    revision: string; reportedAt: string | null; sourceAsOf: string | null; receivedAt: string;
    timeQuality: string; originalSha256: string; origin?: string | null; identityDerivation?: IdentityDerivation; identityBasis?: ReferenceDecisionBasis[]; comparisonIdentity?: ComparisonIdentity };
}
export interface CaseComparison {
  id: string; subject: CaseReference; ruleVersion: string;
  outcome: 'different' | 'within_tolerance' | 'not_comparable' | 'suppressed';
  title: string; explanation: string; inputAssertionIds: string[];
  absoluteDifference: { numerator: string; denominator: string } | null; baseUnit: string | null; physicalCondition: 'not_established';
  inputs?: Array<{ id: string; property: string; value: unknown; source: { connectionId: string; receiptId: string; row: number; field: string; revision: string; reportedAt: string | null; sourceAsOf: string | null; receivedAt: string; comparisonIdentity?: ComparisonIdentity } }>;
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
  accountingAvailable?: boolean;
  accounting: { received: number; acceptedLinked: number; acceptedUnlinked: number; duplicate: number;
    conflict: number; quarantined: number; rejected: number; processing: number; reconciled: boolean };
}
export type CaseSection = 'comparisons' | 'assertions' | 'relationships' | 'timeline' | 'caseLinks' | 'aliases' | 'identityRules' | 'proofs';
export interface ProofPagination { section: 'proofs'; limit: number; total: number; returnedCount: number; hasMore: boolean; nextCursor: string | null; projectionVersion: string }
export interface OperationalCaseDetail {
  proofPagination?: ProofPagination; proofs?: Array<{ id: string; proofId: string }>;
  schema: string; projectionVersion: string; projectionStatus?: { state: 'ready' | 'pending' | 'stale'; caseRevision: number; projectedRevision: number | null; reason?: string }; case: OperationalCaseSummary;
  assertions: CaseAssertion[]; comparisons: CaseComparison[]; relationships: CaseRelationship[];
  caseLinks?: Array<{ id: string; type: 'shared_handling_unit' | 'shared_load' | 'shared_stop'; sharedReference: CaseReference; neighbor: { id: string; reference: string; type: string; locationId: string }; basis: string | { ruleVersion: string; basis: string; sourcePolicyVersion?: string }; sourceObservationId: string; restricted: false }>;
  restrictedCaseLinks?: boolean;
  aliases?: import('./CaseIdentityMappings').EntityAlias[]; identityRules?: import('./CaseIdentityMappings').IdentityRule[]; restrictedAliases?: boolean;
  timeline: CaseTimelineEntry[]; sources: CaseSourceHealth[]; limitations: string[];
  sourceHealthStatus?: { available: boolean; reason: string | null };
  rulesStatus?: { available: boolean; reason: string | null };
  pagination: { section: CaseSection; limit: number; total: number | null; returnedCount: number;
    hasMore: boolean; nextCursor: string | null; projectionVersion: string };
}
export interface CaseSourceExtract {
  assertionId: string; original: { name: string; sha256: string };
  locator: { row: number; field: string }; value: unknown;
  source: { connectionId: string; mappingVersion: string; revision: string; identityDerivation?: IdentityDerivation; identityBasis?: ReferenceDecisionBasis[]; comparisonIdentity?: ComparisonIdentity };
  extraction: 'case_scoped';
  originalAvailable: boolean;
}
