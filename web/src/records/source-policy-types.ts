export interface SourceIdentityPolicy {
  schema: 'packproof.source-identity-policy/v1';
  eventKey: { kind: 'column' } | { kind: 'composite'; fields: string[] };
  revision: { kind: 'column' | 'source_as_of' | 'immutable_event' };
}
export interface PolicySource { subscriptionId: string; sourceNamespace: string; configurationRevision: number }
export interface SourceRulePolicies {
  schema: 'packproof.source-rule-policies/v1'; version: string;
  sourceOwnerQualified: boolean; qualificationReference: string | null;
  labelAcceptance?: {
    labelSource: PolicySource; acceptanceSource: PolicySource; subjectNamespace: string;
    carrier: { code: string; accountReference: string; service: string };
    windowSeconds: number; graceSeconds: number;
    labelCreatedValues: string[]; labelVoidedValues: string[]; acceptedValues: string[];
  };
  handlingUnitHandoff?: {
    expectationSource: PolicySource; loadingSource: PolicySource; receiptSource: PolicySource;
    subjectNamespace: string; scope: 'case_shipment_stop'; dueAtProperty: 'expectedHandoffAt'; windowSeconds: number; graceSeconds: number;
    expectedValues: string[]; loadedValues: string[]; receivedValues: string[];
  };
}
export const IDENTITY_COMPONENT_LABELS: Record<string, string> = {
  orderId: 'Order number', orderLineId: 'Order line', shipmentId: 'Shipment reference',
  handlingUnitId: 'Carton or pallet reference', loadId: 'Load reference', stopId: 'Delivery stop',
  returnId: 'Return reference', productId: 'Product reference', serialId: 'Serial reference',
  trackingId: 'Tracking reference', sourceEventId: 'Source event reference',
  sourceSequence: 'Source event sequence', property: 'Reported field meaning',
};
export interface CrossCaseSourcePolicy {
  schema: 'packproof.cross-case-source-policy/v1'; version: string; allowMultiOrderRows: true;
  partitionRule: 'explicit_order_line_allocations'; sharedEntityTypes: Array<'handling_unit' | 'load' | 'stop'>;
  sourceOwnerQualified: true; qualificationReference: string;
}
